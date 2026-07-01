from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from service.auth import require_api_key
from service.logging_config import get_logger
from service.models.schemas import (
    CompleteTaskRequest,
    CreateTaskRequest,
    Task,
    TaskStatus,
)
from service.store import task_store

logger = get_logger(__name__)

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.post("", response_model=Task, status_code=status.HTTP_201_CREATED)
async def create_task(
    body: CreateTaskRequest,
    _key: str = Depends(require_api_key),
) -> Task:
    """Enqueue a form-filling task. Called by any connected producer."""
    task = Task(payload=body.payload, source=body.source)
    task_store.put(task)
    logger.info("Task created: id=%s platform=%s source=%s", task.task_id, task.payload.platform.value, task.source)
    return task


@router.get("/pending", response_model=Task | None)
async def get_pending_task(
    _key: str = Depends(require_api_key),
) -> Task | None:
    """Return the oldest pending task, and mark it active. Called by the extension."""
    task = task_store.pop_pending()
    if task is None:
        return None
    task.status = TaskStatus.active
    task.updated_at = datetime.now(timezone.utc)
    task_store.put(task)
    logger.info("Task claimed by extension: id=%s platform=%s", task.task_id, task.payload.platform.value)
    return task


@router.get("/{task_id}", response_model=Task)
async def get_task(
    task_id: str,
    _key: str = Depends(require_api_key),
) -> Task:
    task = task_store.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.post("/{task_id}/complete", response_model=Task)
async def complete_task(
    task_id: str,
    body: CompleteTaskRequest,
    _key: str = Depends(require_api_key),
) -> Task:
    """Mark a task complete with the live result URL. Called by the extension."""
    task = task_store.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    task.status = TaskStatus.complete
    task.result_url = body.result_url
    task.updated_at = datetime.now(timezone.utc)
    task_store.put(task)
    return task


@router.post("/{task_id}/fail", response_model=Task)
async def fail_task(
    task_id: str,
    error: str = "",
    _key: str = Depends(require_api_key),
) -> Task:
    task = task_store.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    task.status = TaskStatus.failed
    task.error = error
    task.updated_at = datetime.now(timezone.utc)
    task_store.put(task)
    return task


@router.get("", response_model=list[Task])
async def list_tasks(
    status_filter: str | None = None,
    _key: str = Depends(require_api_key),
) -> list[Task]:
    tasks = task_store.list_all()
    if status_filter:
        tasks = [t for t in tasks if t.status == status_filter]
    return sorted(tasks, key=lambda t: t.created_at, reverse=True)
