from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


class TaskStatus(str, Enum):
    pending = "pending"
    active = "active"
    awaiting_input = "awaiting_input"  # agent paused, needs caller's answer
    complete = "complete"
    failed = "failed"


class TaskPlatform(str, Enum):
    facebook = "facebook"
    instagram = "instagram"
    pinterest = "pinterest"
    twitter = "twitter"
    linkedin = "linkedin"
    generic = "generic"


class MediaAsset(BaseModel):
    """A media file the extension should download and attach to a file input."""
    asset_id: str = Field(default_factory=lambda: str(uuid4()))
    url: str                    # where the service can fetch it
    filename: str               # hint for the File object
    mime_type: str = "application/octet-stream"


class TaskPayload(BaseModel):
    platform: TaskPlatform
    destination: str
    caption: str = ""
    link: str | None = None
    title: str | None = None
    tags: list[str] = Field(default_factory=list)
    media: list[MediaAsset] = Field(default_factory=list)
    extra: dict[str, Any] = Field(default_factory=dict)


class Question(BaseModel):
    """A structured question the agent poses when it cannot proceed unambiguously."""
    question_id: str = Field(default_factory=lambda: str(uuid4()))
    text: str                           # human-readable question
    options: list[str] = Field(default_factory=list)  # suggested answers, if any
    context: str = ""                   # why the agent is asking
    asked_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class QuestionResponse(BaseModel):
    answer: str


class Task(BaseModel):
    task_id: str = Field(default_factory=lambda: str(uuid4()))
    payload: TaskPayload
    status: TaskStatus = TaskStatus.pending
    question: Question | None = None    # set when status == awaiting_input
    graph_thread_id: str | None = None  # LangGraph checkpoint thread
    result_url: str | None = None
    error: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    source: str = "unknown"


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
    platform_hint: str
    inputs: list[InputElement] = Field(default_factory=list)
    buttons: list[ButtonElement] = Field(default_factory=list)
    headings: list[str] = Field(default_factory=list)
    selects: list[dict[str, Any]] = Field(default_factory=list)
    snapshot_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class FillInstruction(BaseModel):
    selector_hint: str
    fallback_hint: str
    value: str
    action: str = "type"              # "type" | "select" | "focus" | "attach_file"
    asset_id: str | None = None       # set when action == "attach_file"


class InspectRequest(BaseModel):
    task_id: str
    snapshot: DomSnapshot


class InspectResponse(BaseModel):
    task_id: str
    status: str                       # "instructions" | "awaiting_input" | "complete"
    instructions: list[FillInstruction] = Field(default_factory=list)
    question: Question | None = None  # set when status == "awaiting_input"
    step_complete: bool = False
    expect_next_page: bool = False
    notes: str = ""


class CompleteTaskRequest(BaseModel):
    result_url: str


class CreateTaskRequest(BaseModel):
    payload: TaskPayload
    source: str = "api"


class ApiKey(BaseModel):
    key_id: str = Field(default_factory=lambda: str(uuid4()))
    key: str
    label: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
