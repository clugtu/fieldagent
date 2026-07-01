"""Inspector Graph — LangGraph state machine for the FieldAgent Inspector.

The graph has three possible outcomes per invocation:

  instructions  — agent produced fill instructions, extension can act
  awaiting_input — agent needs clarification from the caller before
                   it can proceed; execution is suspended until the
                   caller POSTs an answer to /tasks/{id}/respond
  complete       — agent detected the page looks like a success/done state

On an awaiting_input outcome, the graph state is checkpointed.  When
the caller responds, resume_with_answer() reloads that checkpoint and
continues from the ask node with the answer injected into state.
"""

from __future__ import annotations

import json
from typing import Annotated, Any
from uuid import uuid4

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from service.config import settings
from service.logging_config import get_logger
from service.models.schemas import (
    DomSnapshot,
    FillInstruction,
    InspectResponse,
    Question,
    Task,
)
from typing_extensions import TypedDict

logger = get_logger(__name__)

# ─── Graph state ─────────────────────────────────────────────────────────────


class InspectorState(TypedDict):
    task_id: str
    task_payload: dict[str, Any]
    snapshot: dict[str, Any]
    answer: str | None  # injected by resume_with_answer()
    instructions: list[dict[str, Any]]
    question: dict[str, Any] | None
    step_complete: bool
    expect_next_page: bool
    notes: str
    outcome: str  # "instructions" | "awaiting_input" | "complete"
    messages: Annotated[list, add_messages]
    _analyze_result: dict[str, Any]  # internal: decision from analyze node


# ─── LLM ─────────────────────────────────────────────────────────────────────


def _llm() -> ChatAnthropic:
    return ChatAnthropic(model="claude-sonnet-4-6", temperature=0, api_key=settings.anthropic_api_key)


# ─── Nodes ───────────────────────────────────────────────────────────────────

_ANALYZE_PROMPT = """You are the FieldAgent Inspector. You receive a web form snapshot and a task describing content to fill into it. Decide one of three things:

1. FILL — you have enough information to produce fill instructions.
2. ASK  — you cannot proceed without a specific piece of information from the caller.
3. DONE — the page looks like a success/confirmation state; the task is complete.

Output ONLY raw JSON — no markdown, no explanation, no code fences. One of:
{"decision":"fill"}
{"decision":"ask","question":"<concise question>","options":["opt1","opt2"],"context":"<why>"}
{"decision":"done","notes":"<what you saw>"}

Only ask if you genuinely cannot fill without the answer."""

_FILL_PROMPT = """You are the FieldAgent Inspector. Produce fill instructions
for the form described in the snapshot, using the task payload and (if present)
any answer the caller provided to a previous question.

Respond ONLY with valid JSON:
{
  "instructions": [
    {
      "selector_hint": "<CSS attribute selector>",
      "fallback_hint": "<plain English description>",
      "value": "<text or asset_id>",
      "action": "type | select | attach_file",
      "asset_id": "<asset_id if action==attach_file, else null>"
    }
  ],
  "step_complete": false,
  "expect_next_page": false,
  "notes": "<optional commentary>"
}

For media fields (file inputs), set action to "attach_file" and set asset_id
to the matching asset's asset_id from the task payload. The extension will
download and attach the file automatically.
"""


def analyze(state: InspectorState) -> dict:
    """Decide: fill now, ask the caller, or declare done."""
    context = (
        f"TASK:\n{json.dumps(state['task_payload'], indent=2)}\n\n"
        f"SNAPSHOT:\n{json.dumps(state['snapshot'], indent=2)}"
    )
    if state.get("answer"):
        context += f"\n\nCALLER ANSWER TO PREVIOUS QUESTION:\n{state['answer']}"

    msgs = [
        SystemMessage(content=_ANALYZE_PROMPT),
        HumanMessage(content=context),
    ]
    response = _llm().invoke(msgs)
    raw = (
        response.content.strip()
        .removeprefix("```json")
        .removeprefix("```")
        .removesuffix("```")
        .strip()
    )

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("analyze: could not parse LLM response, defaulting to fill")
        parsed = {"decision": "fill"}

    logger.info("analyze decision: %s task=%s", parsed.get("decision"), state["task_id"])
    return {
        "messages": msgs + [response],
        "_analyze_result": parsed,
    }


def route_after_analyze(state: InspectorState) -> str:
    result = state.get("_analyze_result", {})
    return result.get("decision", "fill")


def ask(state: InspectorState) -> dict:
    """Package the agent's question and suspend execution."""
    result = state.get("_analyze_result", {})
    q = Question(
        text=result.get("question", "The agent needs more information to proceed."),
        options=result.get("options", []),
        context=result.get("context", ""),
    )
    return {
        "question": q.model_dump(),
        "outcome": "awaiting_input",
    }


def fill(state: InspectorState) -> dict:
    """Generate fill instructions, incorporating any caller answer."""
    context = (
        f"TASK:\n{json.dumps(state['task_payload'], indent=2)}\n\n"
        f"SNAPSHOT:\n{json.dumps(state['snapshot'], indent=2)}"
    )
    if state.get("answer"):
        context += f"\n\nCALLER ANSWER:\n{state['answer']}"

    msgs = [
        SystemMessage(content=_FILL_PROMPT),
        HumanMessage(content=context),
    ]
    response = _llm().invoke(msgs)
    raw = (
        response.content.strip()
        .removeprefix("```json")
        .removeprefix("```")
        .removesuffix("```")
        .strip()
    )

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("fill: could not parse LLM response for task=%s", state["task_id"])
        parsed = {"instructions": [], "notes": "Parse error in fill node"}

    return {
        "messages": msgs + [response],
        "instructions": parsed.get("instructions", []),
        "step_complete": parsed.get("step_complete", False),
        "expect_next_page": parsed.get("expect_next_page", False),
        "notes": parsed.get("notes", ""),
        "outcome": "instructions",
        "question": None,
    }


def done(state: InspectorState) -> dict:
    result = state.get("_analyze_result", {})
    return {
        "outcome": "complete",
        "notes": result.get(
            "notes", "Page appears to be a success/confirmation state."
        ),
        "step_complete": True,
        "question": None,
    }


# ─── Build graph ──────────────────────────────────────────────────────────────

_checkpointer = MemorySaver()


def _build_graph():
    g = StateGraph(InspectorState)
    g.add_node("analyze", analyze)
    g.add_node("ask", ask)
    g.add_node("fill", fill)
    g.add_node("done", done)

    g.add_edge(START, "analyze")
    g.add_conditional_edges(
        "analyze",
        route_after_analyze,
        {
            "fill": "fill",
            "ask": "ask",
            "done": "done",
        },
    )
    g.add_edge("fill", END)
    g.add_edge("ask", END)
    g.add_edge("done", END)

    return g.compile(checkpointer=_checkpointer)


_graph = _build_graph()


# ─── Public interface ─────────────────────────────────────────────────────────


def _state_from_task_and_snapshot(task: Task, snapshot: DomSnapshot) -> InspectorState:
    return InspectorState(
        task_id=task.task_id,
        task_payload=task.payload.model_dump(mode="json"),
        snapshot=snapshot.model_dump(mode="json"),
        answer=None,
        instructions=[],
        question=None,
        step_complete=False,
        expect_next_page=False,
        notes="",
        outcome="",
        messages=[],
        _analyze_result={},  # type: ignore[typeddict-item]
    )


def _state_to_response(task_id: str, final_state: dict) -> InspectResponse:
    outcome = final_state.get("outcome", "instructions")
    question = None
    if outcome == "awaiting_input" and final_state.get("question"):
        question = Question(**final_state["question"])

    instructions = [FillInstruction(**i) for i in final_state.get("instructions", [])]

    return InspectResponse(
        task_id=task_id,
        status=outcome,
        instructions=instructions,
        question=question,
        step_complete=final_state.get("step_complete", False),
        expect_next_page=final_state.get("expect_next_page", False),
        notes=final_state.get("notes", ""),
    )


async def run_inspector(
    task: Task, snapshot: DomSnapshot
) -> tuple[InspectResponse, str]:
    """Run the graph from scratch. Returns (response, thread_id)."""
    thread_id = str(uuid4())
    config = {"configurable": {"thread_id": thread_id}}
    initial = _state_from_task_and_snapshot(task, snapshot)

    logger.info("[GRAPH] Starting | task=%s thread=%s", task.task_id, thread_id)
    final = await _graph.ainvoke(initial, config=config)
    return _state_to_response(task.task_id, final), thread_id


async def resume_with_answer(task: Task, answer: str) -> InspectResponse:
    """Resume a suspended graph after the caller answers a question.

    The snapshot is already in the checkpointed state from the initial run.
    If the page has meaningfully changed since then, the caller should start
    a fresh inspect cycle instead.
    """
    thread_id = task.graph_thread_id
    if not thread_id:
        raise ValueError(f"Task {task.task_id} has no saved graph thread to resume")

    config = {"configurable": {"thread_id": thread_id}}
    logger.info("[GRAPH] Resuming | task=%s thread=%s", task.task_id, thread_id)

    update = {
        "answer": answer,
        "outcome": "",  # reset so analyze re-evaluates with the answer
        "question": None,
    }
    final = await _graph.ainvoke(update, config=config)
    return _state_to_response(task.task_id, final)
