from __future__ import annotations

import httpx
import pytest

from backend import app as app_module


@pytest.fixture(autouse=True)
def clear_sessions() -> None:
    app_module.sessions.clear()


@pytest.fixture
def stub_n8n_trigger(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    triggered: list[dict] = []

    async def fake_trigger(snapshot) -> None:
        triggered.append({
            "session_id": snapshot.session_id,
            "query": snapshot.query,
            "budget_cap_usd": snapshot.budget.cap_usd,
            "max_subquestions": snapshot.settings.max_subquestions,
            "max_papers_per_subquestion": snapshot.settings.max_papers_per_subquestion,
            "max_chunks_per_paper": snapshot.settings.max_chunks_per_paper,
        })

    monkeypatch.setattr(app_module, "_trigger_n8n_session", fake_trigger)
    return triggered


@pytest.mark.asyncio
async def test_create_session_returns_snapshot_and_stores_session(
    stub_n8n_trigger: list[dict],
) -> None:
    transport = httpx.ASGITransport(app=app_module.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/api/session",
            json={
                "query": "How should RAG systems handle noisy retrieval?",
                "budget_cap_usd": 0.05,
                "max_subquestions": 4,
                "max_papers_per_subquestion": 3,
                "max_chunks_per_paper": 5,
            },
        )

    assert response.status_code == 200
    payload = response.json()

    assert payload["status"] == "queued"
    assert payload["session_id"].startswith("sess_")
    assert payload["stream_url"] == f"/api/session/{payload['session_id']}/stream"
    assert payload["snapshot"]["query"] == "How should RAG systems handle noisy retrieval?"
    assert payload["snapshot"]["budget"]["cap_usd"] == 0.05
    assert payload["session_id"] in app_module.sessions
    assert stub_n8n_trigger == [{
        "session_id": payload["session_id"],
        "query": "How should RAG systems handle noisy retrieval?",
        "budget_cap_usd": 0.05,
        "max_subquestions": 4,
        "max_papers_per_subquestion": 3,
        "max_chunks_per_paper": 5,
    }]


@pytest.mark.asyncio
async def test_create_session_returns_502_when_n8n_trigger_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def failing_trigger(_snapshot) -> None:
        raise httpx.ConnectError("n8n unavailable")

    monkeypatch.setattr(app_module, "_trigger_n8n_session", failing_trigger)

    transport = httpx.ASGITransport(app=app_module.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/api/session",
            json={"query": "What are the limits of RAG?"},
        )

    assert response.status_code == 502
    assert response.json()["detail"].startswith("Failed to trigger n8n workflow:")
    assert app_module.sessions == {}


@pytest.mark.asyncio
async def test_webhook_endpoint_updates_session_snapshot(
    stub_n8n_trigger: list[dict],
) -> None:
    transport = httpx.ASGITransport(app=app_module.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        create_response = await client.post(
            "/api/session",
            json={"query": "What are the limits of RAG?"},
        )
        session_id = create_response.json()["session_id"]

        webhook_response = await client.post(
            "/api/webhook/session-update",
            json={
                "session_id": session_id,
                "status": "running",
                "active_stage": "retrieving_papers",
                "event": {
                    "id": "evt_1",
                    "stage": "retrieval",
                    "message": "Retrieved 2 papers.",
                    "created_at": "2026-04-05T14:00:10Z",
                },
                "budget": {
                    "cap_usd": 0.05,
                    "spent_usd": 0.012,
                    "remaining_usd": 0.038,
                    "estimated_next_step_usd": 0.004,
                },
            },
        )
        snapshot_response = await client.get(f"/api/session/{session_id}")

    assert webhook_response.status_code == 200
    assert webhook_response.json() == {"ok": True}
    assert snapshot_response.status_code == 200
    snapshot = snapshot_response.json()
    assert snapshot["status"] == "running"
    assert snapshot["active_stage"] == "retrieving_papers"
    assert snapshot["budget"]["spent_usd"] == 0.012
    assert snapshot["events"][0]["message"] == "Retrieved 2 papers."


@pytest.mark.asyncio
async def test_missing_session_endpoints_return_404() -> None:
    transport = httpx.ASGITransport(app=app_module.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        snapshot_response = await client.get("/api/session/does-not-exist")
        stream_response = await client.get("/api/session/does-not-exist/stream")

    assert snapshot_response.status_code == 404
    assert snapshot_response.json()["detail"] == "Session not found"
    assert stream_response.status_code == 404
    assert stream_response.json()["detail"] == "Session not found"
