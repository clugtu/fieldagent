import os

import pytest
from fastapi.testclient import TestClient

# Set placeholder env vars before any service module imports so
# pydantic-settings doesn't error on missing ANTHROPIC_API_KEY.
os.environ.setdefault("ANTHROPIC_API_KEY", "placeholder")
os.environ.setdefault("FIELDAGENT_API_KEYS", "test-key")

from service.main import app  # noqa: E402
from service.store import task_store  # noqa: E402


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def clear_store():
    """Reset the task store between tests."""
    task_store._tasks.clear()
    yield
    task_store._tasks.clear()
