"""Asset proxy — the extension fetches media through here so it only needs
one authenticated endpoint rather than separate credentials per asset origin."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from service.auth import require_api_key
from service.store import task_store

router = APIRouter(prefix="/assets", tags=["assets"])


@router.get("/{task_id}/{asset_id}")
async def get_asset(
    task_id: str,
    asset_id: str,
    _key: str = Depends(require_api_key),
) -> StreamingResponse:
    """Proxy the asset file for the extension to download.

    The extension fetches this endpoint, receives the raw bytes, builds a
    File object, and attaches it to the matching <input type="file"> via
    DataTransfer.
    """
    task = task_store.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    asset = next(
        (a for a in task.payload.media if a.asset_id == asset_id),
        None,
    )
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")

    async def stream():
        async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
            async with client.stream("GET", asset.url) as r:
                r.raise_for_status()
                async for chunk in r.aiter_bytes(chunk_size=64 * 1024):
                    yield chunk

    return StreamingResponse(
        stream(),
        media_type=asset.mime_type,
        headers={"Content-Disposition": f'attachment; filename="{asset.filename}"'},
    )
