"""Public interface for the Inspector — delegates to the LangGraph graph."""

from __future__ import annotations

from service.agents.graph import resume_with_answer, run_inspector
from service.models.schemas import DomSnapshot, InspectResponse, Task

__all__ = ["run_inspector", "resume_with_answer"]
