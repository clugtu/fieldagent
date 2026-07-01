from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from service.agents.inspector import run_inspector
from service.models.schemas import InspectRequest, InspectResponse, TaskStatus
from service.store import task_store
from service.auth import require_api_key

router = APIRouter(prefix="/inspect", tags=["inspect"])


@router.post("", response_model=InspectResponse)
async def inspect(
    body: InspectRequest,
    _key: str = Depends(require_api_key),
) -> InspectResponse:
    """Receive a DOM snapshot from the extension, run the Inspector Agent,
    return fill instructions.

    The extension calls this on every significant page load / DOM change
    while a task is active.
    """
    task = task_store.get(body.task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status not in (TaskStatus.pending, TaskStatus.active):
        raise HTTPException(
            status_code=409,
            detail=f"Task {body.task_id} is {task.status} — cannot inspect",
        )

    return await run_inspector(task, body.snapshot)
