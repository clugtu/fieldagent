"""SQLite-backed task store. Survives service restarts."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from threading import Lock

from service.models.schemas import Task, TaskStatus


class TaskStore:
    def __init__(self, db_path: str | Path = "./fieldagent.db") -> None:
        self._db = Path(db_path)
        self._lock = Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tasks (
                    task_id TEXT PRIMARY KEY,
                    data    TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def put(self, task: Task) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO tasks (task_id, data, created_at) VALUES (?, ?, ?)",
                (task.task_id, task.model_dump_json(), str(task.created_at)),
            )
            conn.commit()

    def get(self, task_id: str) -> Task | None:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT data FROM tasks WHERE task_id = ?", (task_id,)
            ).fetchone()
        return Task.model_validate_json(row["data"]) if row else None

    def pop_pending(self) -> Task | None:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT data FROM tasks WHERE json_extract(data, '$.status') = ? ORDER BY created_at LIMIT 1",
                (TaskStatus.pending,),
            ).fetchone()
        return Task.model_validate_json(row["data"]) if row else None

    def list_all(self) -> list[Task]:
        with self._lock, self._connect() as conn:
            rows = conn.execute("SELECT data FROM tasks ORDER BY created_at").fetchall()
        return [Task.model_validate_json(r["data"]) for r in rows]


task_store = TaskStore()
