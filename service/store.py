"""In-memory task store. Replace with SQLite or Redis for production."""

from __future__ import annotations

from collections import OrderedDict
from threading import Lock

from service.models.schemas import Task, TaskStatus


class TaskStore:
    def __init__(self) -> None:
        self._tasks: OrderedDict[str, Task] = OrderedDict()
        self._lock = Lock()

    def put(self, task: Task) -> None:
        with self._lock:
            self._tasks[task.task_id] = task

    def get(self, task_id: str) -> Task | None:
        with self._lock:
            return self._tasks.get(task_id)

    def pop_pending(self) -> Task | None:
        """Return the oldest pending task without removing it (caller updates status)."""
        with self._lock:
            for task in self._tasks.values():
                if task.status == TaskStatus.pending:
                    return task
        return None

    def list_all(self) -> list[Task]:
        with self._lock:
            return list(self._tasks.values())


task_store = TaskStore()
