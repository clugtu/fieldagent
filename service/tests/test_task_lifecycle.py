"""
Story #6 — Service: verify task lifecycle create → claim → complete.
"""

HEADERS = {"X-API-Key": "test-key"}

PAYLOAD = {
    "payload": {
        "platform": "pinterest",
        "destination": "pinterest",
        "caption": "A haunting folk horror figure.",
        "link": "https://example.com/listing",
        "title": "Bog Witch",
        "media": [],
    },
    "source": "test",
}


def test_create_task_returns_pending(client):
    resp = client.post("/tasks", json=PAYLOAD, headers=HEADERS)
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "pending"
    assert data["task_id"]
    assert data["payload"]["platform"] == "pinterest"


def test_get_pending_claims_task_and_flips_to_active(client):
    client.post("/tasks", json=PAYLOAD, headers=HEADERS)

    resp = client.get("/tasks/pending", headers=HEADERS)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "active"


def test_get_pending_returns_null_when_queue_empty(client):
    resp = client.get("/tasks/pending", headers=HEADERS)
    assert resp.status_code == 200
    assert resp.json() is None


def test_complete_task_sets_result_url(client):
    create = client.post("/tasks", json=PAYLOAD, headers=HEADERS).json()
    task_id = create["task_id"]
    client.get("/tasks/pending", headers=HEADERS)  # claim it

    result_url = "https://www.pinterest.com/pin/123456/"
    resp = client.post(
        f"/tasks/{task_id}/complete",
        json={"result_url": result_url},
        headers=HEADERS,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "complete"
    assert data["result_url"] == result_url


def test_get_task_by_id(client):
    create = client.post("/tasks", json=PAYLOAD, headers=HEADERS).json()
    task_id = create["task_id"]

    resp = client.get(f"/tasks/{task_id}", headers=HEADERS)
    assert resp.status_code == 200
    assert resp.json()["task_id"] == task_id


def test_get_task_404_for_unknown_id(client):
    resp = client.get("/tasks/does-not-exist", headers=HEADERS)
    assert resp.status_code == 404


def test_requires_api_key(client):
    resp = client.post("/tasks", json=PAYLOAD)
    assert resp.status_code == 401


def test_only_first_pending_task_is_claimed(client):
    client.post("/tasks", json=PAYLOAD, headers=HEADERS)
    client.post("/tasks", json=PAYLOAD, headers=HEADERS)

    client.get("/tasks/pending", headers=HEADERS)  # claim first
    client.get("/tasks/pending", headers=HEADERS)  # claim second

    resp = client.get("/tasks/pending", headers=HEADERS)
    assert resp.json() is None  # queue now empty
