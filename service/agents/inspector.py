"""Inspector Agent — the brain of FieldAgent.

Receives a DOM snapshot + active task and returns structured fill
instructions. Uses a LangChain ReAct agent backed by Claude so it can
reason through ambiguous page states, multi-step flows, and unexpected
layouts rather than relying on hardcoded selectors.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import SystemMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.tools import tool

from service.models.schemas import DomSnapshot, FillInstruction, InspectResponse, Task

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = """You are FieldAgent Inspector, an AI agent that helps automate
filling in web forms on social media platforms. You receive a semantic snapshot
of the current page (inputs, buttons, headings — not raw HTML) alongside a posting
task, and you return structured instructions telling a Chrome extension exactly
which fields to fill and with what values.

Rules:
- You ONLY fill fields. You never instruct the extension to click Submit/Publish/Post.
  The human user always makes the final call.
- Be conservative. If you are unsure which field to fill, use a note rather than
  guess wrong and corrupt a field.
- selector_hint should be a valid CSS attribute selector when possible
  (e.g. textarea[aria-label="What's on your mind?"]).
- fallback_hint is a plain-English description the extension uses as a last resort.
- If the page looks like a login wall, error page, or something unexpected, return
  zero instructions and explain in notes.
- For multi-step flows, set expect_next_page=true when you can tell the current
  page is one step in a wizard (e.g. it has a "Next" button, the heading says
  "Step 1 of 3", etc.).
"""


@tool
def identify_composer_fields(snapshot_json: str) -> str:
    """Parse a DOM snapshot and return a structured list of candidate fields
    that are likely part of a post composer (text areas, title inputs, link
    fields, etc.), filtering out navigation, search, and other noise.

    Args:
        snapshot_json: JSON string of a DomSnapshot
    """
    snapshot = json.loads(snapshot_json)
    inputs = snapshot.get("inputs", [])
    composer_signals = {
        "textarea", "post", "caption", "message", "description",
        "title", "link", "url", "board", "what's on your mind",
        "share", "compose", "write",
    }

    candidates = []
    for inp in inputs:
        text = " ".join([
            inp.get("placeholder", ""),
            inp.get("aria_label", ""),
            inp.get("label_text", ""),
            inp.get("name", ""),
            inp.get("id", ""),
        ]).lower()

        if any(signal in text for signal in composer_signals):
            candidates.append(inp)
        elif inp.get("tag") == "textarea":
            candidates.append(inp)

    return json.dumps(candidates, indent=2)


@tool
def detect_platform_step(snapshot_json: str) -> str:
    """Analyze the snapshot to determine which step of a multi-page posting
    flow this is (if any), and whether a "Next" / "Continue" button exists.

    Returns a JSON object: {"step_hint": str, "has_next_button": bool,
    "looks_like_success": bool, "looks_like_login_wall": bool}
    """
    snapshot = json.loads(snapshot_json)
    headings = [h.lower() for h in snapshot.get("headings", [])]
    buttons = [b.get("text", "").lower() for b in snapshot.get("buttons", [])]
    url = snapshot.get("url", "").lower()
    title = snapshot.get("title", "").lower()

    step_hint = "unknown"
    for h in headings:
        if "step" in h or "create" in h or "compose" in h or "new post" in h:
            step_hint = h
            break

    looks_like_login = any(
        kw in url or kw in title
        for kw in ["login", "signin", "log_in", "auth", "checkpoint"]
    )

    looks_like_success = any(
        kw in url or kw in title
        for kw in ["success", "published", "posted", "live", "confirmation"]
    )

    has_next = any(b in ("next", "continue", "next step") for b in buttons)

    return json.dumps({
        "step_hint": step_hint,
        "has_next_button": has_next,
        "looks_like_success": looks_like_success,
        "looks_like_login_wall": looks_like_login,
    })


_TOOLS = [identify_composer_fields, detect_platform_step]


def _build_agent(model_name: str = "claude-sonnet-4-6") -> AgentExecutor:
    llm = ChatAnthropic(model=model_name, temperature=0)

    prompt = ChatPromptTemplate.from_messages([
        SystemMessage(content=_SYSTEM_PROMPT),
        ("human", "{input}"),
        MessagesPlaceholder(variable_name="agent_scratchpad"),
    ])

    agent = create_tool_calling_agent(llm, _TOOLS, prompt)
    return AgentExecutor(agent=agent, tools=_TOOLS, verbose=False, max_iterations=6)


def _build_input(task: Task, snapshot: DomSnapshot) -> str:
    return f"""TASK:
{task.payload.model_dump_json(indent=2)}

DOM SNAPSHOT:
{snapshot.model_dump_json(indent=2)}

Based on the task payload and the DOM snapshot above, return fill instructions
as a JSON object matching this schema:
{{
  "instructions": [
    {{
      "selector_hint": "<CSS selector>",
      "fallback_hint": "<plain English>",
      "value": "<text to fill>",
      "action": "type"
    }}
  ],
  "step_complete": false,
  "expect_next_page": false,
  "notes": "<optional commentary>"
}}

Use the available tools to inspect the snapshot before deciding. Return ONLY
the JSON object, nothing else.
"""


async def run_inspector(task: Task, snapshot: DomSnapshot) -> InspectResponse:
    """Run the Inspector Agent and return structured fill instructions."""
    executor = _build_agent()
    agent_input = _build_input(task, snapshot)

    logger.info(
        "[INSPECTOR] Running agent | task=%s platform=%s url=%s",
        task.task_id,
        task.payload.platform,
        snapshot.url,
    )

    try:
        result = await executor.ainvoke({"input": agent_input})
        output: str = result.get("output", "")
        # Strip any markdown code fences the model might add
        output = output.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed: dict[str, Any] = json.loads(output)
    except Exception as exc:
        logger.exception("[INSPECTOR] Agent failed: %s", exc)
        return InspectResponse(
            task_id=task.task_id,
            instructions=[],
            notes=f"Agent error: {exc}",
        )

    instructions = [
        FillInstruction(**i) for i in parsed.get("instructions", [])
    ]

    return InspectResponse(
        task_id=task.task_id,
        instructions=instructions,
        step_complete=parsed.get("step_complete", False),
        expect_next_page=parsed.get("expect_next_page", False),
        notes=parsed.get("notes", ""),
    )
