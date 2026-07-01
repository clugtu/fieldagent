"""FieldAgent Service — FastAPI entry point."""

from __future__ import annotations

import os
import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from service.api import assets as assets_router
from service.api import inspect as inspect_router
from service.api import tasks as tasks_router
from service.auth import register_key
from service.config import settings
from service.logging_config import get_logger, setup_logging

setup_logging(log_dir=settings.logs_dir, level=settings.log_level)
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Propagate LLM API key from pydantic-settings into os.environ so that
    # LangChain's init_chat_model can discover it via its standard env-var lookup.
    # (pydantic-settings reads .env into the Settings object, not os.environ.)
    if settings.anthropic_api_key:
        os.environ.setdefault("ANTHROPIC_API_KEY", settings.anthropic_api_key)

    logger.info("LLM: provider=%s model=%s", settings.llm_provider, settings.llm_model)

    if not settings.api_keys:
        key = secrets.token_urlsafe(32)
        register_key(key)
        logger.warning("No API keys configured. Generated a bootstrap key: %s", key)
        logger.warning("Set FIELDAGENT_API_KEYS=<key> in .env to make it persistent.")
    else:
        for key in settings.api_keys:
            register_key(key)
        logger.info("Registered %d API key(s)", len(settings.api_keys))

    yield


app = FastAPI(
    title="FieldAgent Service",
    description="AI-powered browser form-filling microservice for FieldAgent.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tasks_router.router)
app.include_router(inspect_router.router)
app.include_router(assets_router.router)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "fieldagent"}
