"""FieldAgent Service — FastAPI entry point."""

from __future__ import annotations

import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from service.api import inspect as inspect_router
from service.api import tasks as tasks_router
from service.auth import register_key
from service.config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure at least one API key exists on startup so the service is
    # immediately usable. Printed to stdout for initial setup.
    if not settings.api_keys:
        key = secrets.token_urlsafe(32)
        register_key(key)
        print(f"\n[FieldAgent] No API keys configured. Generated a bootstrap key:")
        print(f"  {key}")
        print("  Set FIELDAGENT_API_KEYS=<key> in .env to make it persistent.\n")
    else:
        for key in settings.api_keys:
            register_key(key)

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


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "fieldagent"}
