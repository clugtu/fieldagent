"""
Story #7 — Inspector graph: analyze → fill path returns instructions.

The LLM is mocked so these tests run without an API key and stay fast.
"""

import json
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from service.agents.graph import run_inspector
from service.models.schemas import (
    ButtonElement,
    DomSnapshot,
    InputElement,
    Task,
    TaskPayload,
    TaskPlatform,
)


def _make_task(**kwargs) -> Task:
    defaults = dict(
        platform=TaskPlatform.pinterest,
        destination="pinterest",
        caption="A haunting folk horror figure.",
        title="Bog Witch",
        link="https://example.com/listing",
    )
    defaults.update(kwargs)
    return Task(payload=TaskPayload(**defaults))


def _make_snapshot(**kwargs) -> DomSnapshot:
    defaults = dict(
        url="https://www.pinterest.com/pin/creation/button/",
        title="Create Pin | Pinterest",
        platform_hint="pinterest",
        inputs=[
            InputElement(
                tag="input",
                type="text",
                placeholder="Add a title",
                aria_label="Title",
                label_text="Title",
            ),
            InputElement(
                tag="textarea",
                placeholder="Tell everyone what your Pin is about",
                aria_label="Description",
                label_text="Description",
            ),
        ],
        buttons=[ButtonElement(text="Publish", type="submit")],
        headings=["Create Pin"],
    )
    defaults.update(kwargs)
    return DomSnapshot(**defaults)


def _mock_llm(analyze_response: dict, fill_response: dict):
    """Return a context manager that patches _llm() for one full graph run.

    Returns proper AIMessage objects so LangGraph's add_messages reducer
    accepts them without coercion errors.
    """
    analyze_json = json.dumps(analyze_response)
    fill_json = json.dumps(fill_response)
    call_count = {"n": 0}

    class _FakeLLM:
        def invoke(self, msgs):
            call_count["n"] += 1
            content = analyze_json if call_count["n"] == 1 else fill_json
            return AIMessage(content=content)

    return patch("service.agents.graph._llm", return_value=_FakeLLM())


# ── analyze → fill path ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fill_path_returns_instructions():
    analyze_resp = {"decision": "fill"}
    fill_resp = {
        "instructions": [
            {
                "selector_hint": "input[aria-label='Title']",
                "fallback_hint": "title input",
                "value": "Bog Witch",
                "action": "type",
                "asset_id": None,
            },
            {
                "selector_hint": "textarea[aria-label='Description']",
                "fallback_hint": "description textarea",
                "value": "A haunting folk horror figure.",
                "action": "type",
                "asset_id": None,
            },
        ],
        "step_complete": False,
        "expect_next_page": False,
        "notes": "",
    }

    with _mock_llm(analyze_resp, fill_resp):
        response, thread_id = await run_inspector(_make_task(), _make_snapshot())

    assert response.status == "instructions"
    assert len(response.instructions) == 2
    assert response.instructions[0].selector_hint == "input[aria-label='Title']"
    assert response.instructions[0].value == "Bog Witch"
    assert response.instructions[1].action == "type"
    assert thread_id  # checkpoint id assigned


@pytest.mark.asyncio
async def test_fill_path_step_complete_flag():
    analyze_resp = {"decision": "fill"}
    fill_resp = {
        "instructions": [],
        "step_complete": True,
        "expect_next_page": False,
        "notes": "Confirmation page detected.",
    }

    with _mock_llm(analyze_resp, fill_resp):
        response, _ = await run_inspector(_make_task(), _make_snapshot())

    assert response.step_complete is True
    assert "Confirmation" in response.notes


# ── analyze → ask path ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ask_path_returns_awaiting_input():
    analyze_resp = {
        "decision": "ask",
        "question": "Which board should this pin go to?",
        "options": ["Folk Horror", "Miniatures", "All Minis"],
        "context": "Three boards found on the page.",
    }

    # fill node should not be reached; patch returns empty to be safe
    with _mock_llm(analyze_resp, {}):
        response, _ = await run_inspector(_make_task(), _make_snapshot())

    assert response.status == "awaiting_input"
    assert response.question is not None
    assert "board" in response.question.text.lower()
    assert "Folk Horror" in response.question.options


# ── analyze → done path ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_done_path_returns_complete():
    analyze_resp = {
        "decision": "done",
        "notes": "Page title is 'Pin published'. Task complete.",
    }

    with _mock_llm(analyze_resp, {}):
        response, _ = await run_inspector(_make_task(), _make_snapshot())

    assert response.status == "complete"
    assert response.step_complete is True


# ── fill instruction with attach_file ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_attach_file_instruction_shape():
    analyze_resp = {"decision": "fill"}
    fill_resp = {
        "instructions": [
            {
                "selector_hint": "input[type='file']",
                "fallback_hint": "file upload input",
                "value": "",
                "action": "attach_file",
                "asset_id": "asset-uuid-123",
            }
        ],
        "step_complete": False,
        "expect_next_page": False,
        "notes": "",
    }

    with _mock_llm(analyze_resp, fill_resp):
        response, _ = await run_inspector(_make_task(), _make_snapshot())

    ins = response.instructions[0]
    assert ins.action == "attach_file"
    assert ins.asset_id == "asset-uuid-123"
