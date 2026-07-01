"""Centralized logging for FieldAgent service."""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

_logging_initialized = False


def setup_logging(
    log_dir: str | Path = "./logs",
    level: str = "INFO",
    max_bytes: int = 10 * 1024 * 1024,
    backup_count: int = 5,
) -> logging.Logger:
    global _logging_initialized
    was_initialized = _logging_initialized

    log_path = Path(log_dir)
    log_path.mkdir(parents=True, exist_ok=True)

    numeric_level = getattr(logging, level.upper(), logging.INFO)

    root = logging.getLogger()
    root.setLevel(numeric_level)
    root.handlers.clear()

    detailed_fmt = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(name)s | %(filename)s:%(lineno)d | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    console_fmt = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(console_fmt)
    root.addHandler(console_handler)

    file_handler = RotatingFileHandler(
        filename=log_path / "fieldagent.log",
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    file_handler.setFormatter(detailed_fmt)
    root.addHandler(file_handler)

    for noisy in ("uvicorn.access", "httpx", "httpcore", "anthropic", "watchfiles"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _logging_initialized = True
    if not was_initialized:
        root.info(
            "Logging initialized: level=%s dir=%s", level.upper(), log_path.resolve()
        )

    return root


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
