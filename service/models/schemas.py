from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


class TaskStatus(str, Enum):
    pending = "pending"
    active = "active"
    complete = "complete"
    failed = "failed"


class TaskPlatform(str, Enum):
    facebook = "facebook"
    instagram = "instagram"
    pinterest = "pinterest"
    twitter = "twitter"
    linkedin = "linkedin"


class TaskPayload(BaseModel):
    platform: TaskPlatform
    destination: str  # e.g. "facebook", "instagram" (for multi-destination Meta posts)
    caption: str
    image_url: str | None = None
    link: str | None = None
    title: str | None = None
    tags: list[str] = Field(default_factory=list)
    extra: dict[str, Any] = Field(default_factory=dict)


class Task(BaseModel):
    task_id: str = Field(default_factory=lambda: str(uuid4()))
    payload: TaskPayload
    status: TaskStatus = TaskStatus.pending
    result_url: str | None = None
    error: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    source: str = "unknown"  # e.g. "api", "extension", "cli"


class InputElement(BaseModel):
    tag: str
    type: str | None = None
    name: str = ""
    id: str = ""
    placeholder: str = ""
    aria_label: str = ""
    label_text: str = ""
    current_value: str = ""


class ButtonElement(BaseModel):
    text: str
    type: str = "button"
    disabled: bool = False


class DomSnapshot(BaseModel):
    url: str
    title: str
    platform_hint: str  # derived from hostname
    inputs: list[InputElement] = Field(default_factory=list)
    buttons: list[ButtonElement] = Field(default_factory=list)
    headings: list[str] = Field(default_factory=list)
    selects: list[dict[str, Any]] = Field(default_factory=list)
    snapshot_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class FillInstruction(BaseModel):
    selector_hint: str     # CSS selector or attribute selector, tried first
    fallback_hint: str     # human-readable description, used if selector fails
    value: str
    action: str = "type"  # "type" | "select" | "focus"


class InspectRequest(BaseModel):
    task_id: str
    snapshot: DomSnapshot


class InspectResponse(BaseModel):
    task_id: str
    instructions: list[FillInstruction]
    step_complete: bool = False   # current page is fully filled
    expect_next_page: bool = False  # more steps expected after user navigates
    notes: str = ""               # agent commentary (logged, not shown to user)


class CompleteTaskRequest(BaseModel):
    result_url: str


class CreateTaskRequest(BaseModel):
    payload: TaskPayload
    source: str = "api"


class ApiKeyCreate(BaseModel):
    label: str = ""


class ApiKey(BaseModel):
    key_id: str = Field(default_factory=lambda: str(uuid4()))
    key: str
    label: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
