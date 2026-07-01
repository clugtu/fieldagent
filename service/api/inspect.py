from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from service.agents.inspector import resume_with_answer, run_inspector
from service.auth import require_api_key
from service.models.schemas import (
    InspectRequest,
    InspectResponse,
    QuestionResponse,
    TaskStatus,
)
from service.store import task_store

router = APIRouter(prefix="/inspect", tags=["inspect"])


@router.post("", response_model=InspectResponse)
async def inspect(
    body: InspectRequest,
    _key: str = Depends(require_api_key),
) -> InspectResponse:
    """Receive a DOM snapshot from the extension, run the Inspector Graph,
    return fill instructions or a question for the caller."""
    task = task_store.get(body.task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status not in (TaskStatus.pending, TaskStatus.active):
        raise HTTPException(
            status_code=409,
            detail=f"Task {body.task_id} is {task.status} — cannot inspect",
        )

    response, thread_id = await run_inspector(task, body.snapshot)

    # Persist graph thread ID and status update
    task.graph_thread_id = thread_id
    if response.status == "awaiting_input":
        task.status = TaskStatus.awaiting_input
        task.question = response.question
    else:
        task.status = TaskStatus.active
        task.question = None
    task.updated_at = datetime.now(timezone.utc)
    task_store.put(task)

    return response


@router.post("/respond/{task_id}", response_model=InspectResponse)
async def respond(
    task_id: str,
    body: QuestionResponse,
    _key: str = Depends(require_api_key),
) -> InspectResponse:
    """Caller answers the agent's question. Resumes the suspended graph."""
    task = task_store.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status != TaskStatus.awaiting_input:
        raise HTTPException(
            status_code=409,
            detail=f"Task {task_id} is not awaiting input (status: {task.status})",
        )

    # We need a fresh snapshot from the extension — for now we re-use the
    # last known snapshot embedded in the graph state. The extension should
    # re-send a snapshot alongside the answer if the page has changed; a
    # separate /inspect/respond-with-snapshot endpoint can be added if needed.
    response = await resume_with_answer(task, answer=body.answer)

    if response.status == "awaiting_input":
        task.question = response.question
    else:
        task.status = TaskStatus.active
        task.question = None
    task.updated_at = datetime.now(timezone.utc)
    task_store.put(task)

    return response
