"""
Story #14 — Service: /assets proxy streams bytes from remote URL.

Done when:
- GET /assets/{task_id}/{asset_id} returns correct bytes and Content-Type
- 404 on missing task or asset
"""

from unittest.mock import AsyncMock, MagicMock, patch

HEADERS = {"X-API-Key": "test-key"}

PAYLOAD = {
    "payload": {
        "platform": "generic",
        "destination": "example.com",
        "caption": "Test",
        "media": [
            {
                "asset_id": "asset-abc",
                "url": "https://example.com/image.jpg",
                "filename": "image.jpg",
                "mime_type": "image/jpeg",
            }
        ],
    },
    "source": "test",
}

FAKE_IMAGE_BYTES = b"\xff\xd8\xff\xe0test-jpeg-bytes"


def _make_stream_mock():
    """Return a mock context manager that yields fake image chunks."""
    chunk_iter = AsyncMock()
    chunk_iter.__aiter__ = lambda self: self
    chunk_iter.__anext__ = AsyncMock(
        side_effect=[FAKE_IMAGE_BYTES, StopAsyncIteration()]
    )

    stream_resp = MagicMock()
    stream_resp.raise_for_status = MagicMock()
    stream_resp.headers = {"content-type": "image/jpeg", "content-disposition": ""}
    stream_resp.aiter_bytes = MagicMock(return_value=chunk_iter)

    ctx = AsyncMock()
    ctx.__aenter__ = AsyncMock(return_value=stream_resp)
    ctx.__aexit__ = AsyncMock(return_value=False)

    client = AsyncMock()
    client.stream = MagicMock(return_value=ctx)

    outer_ctx = AsyncMock()
    outer_ctx.__aenter__ = AsyncMock(return_value=client)
    outer_ctx.__aexit__ = AsyncMock(return_value=False)
    return outer_ctx


def test_asset_proxy_returns_bytes_and_content_type(client):
    create = client.post("/tasks", json=PAYLOAD, headers=HEADERS).json()
    task_id = create["task_id"]

    with patch("httpx.AsyncClient", return_value=_make_stream_mock()):
        resp = client.get(f"/assets/{task_id}/asset-abc", headers=HEADERS)

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/jpeg")
    assert resp.content == FAKE_IMAGE_BYTES


def test_asset_proxy_404_on_missing_task(client):
    resp = client.get("/assets/no-such-task/asset-abc", headers=HEADERS)
    assert resp.status_code == 404


def test_asset_proxy_404_on_missing_asset(client):
    create = client.post("/tasks", json=PAYLOAD, headers=HEADERS).json()
    task_id = create["task_id"]

    resp = client.get(f"/assets/{task_id}/no-such-asset", headers=HEADERS)
    assert resp.status_code == 404


def test_asset_proxy_requires_api_key(client):
    resp = client.get("/assets/any-task/any-asset")
    assert resp.status_code == 401
