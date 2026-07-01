"""Simple API key auth. Keys are stored in memory and seeded from env for now."""

from __future__ import annotations

import os

from fastapi import HTTPException, Security, status
from fastapi.security import APIKeyHeader

_API_KEY_HEADER = APIKeyHeader(name="X-API-Key", auto_error=False)

# Seed a key from the environment so the service is usable without a UI.
# In production, keys are managed via POST /auth/keys.
_VALID_KEYS: set[str] = set(
    k.strip() for k in os.getenv("FIELDAGENT_API_KEYS", "").split(",") if k.strip()
)


def register_key(key: str) -> None:
    _VALID_KEYS.add(key)


def require_api_key(api_key: str | None = Security(_API_KEY_HEADER)) -> str:
    if not api_key or api_key not in _VALID_KEYS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key",
        )
    return api_key
