"""Purpose: Expose the FastAPI app, session endpoints, webhook receiver, and live update stream for the research agent."""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .models import (
    BudgetState,
    CreateSessionRequest,
    CreateSessionResponse,
    GraphSnapshot,
    ResearchSettings,
    SessionSnapshot,
    SessionUpdateEvent,
    WebhookUpdateRequest,
)
from .streaming import stream_manager
from .webhooks import apply_webhook_update

app = FastAPI(title="Research Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory session store ───────────────────────────────────────────────────
sessions: dict[str, SessionSnapshot] = {}

N8N_WEBHOOK_URL = os.environ.get("N8N_WEBHOOK_URL", "http://localhost:5678/webhook/research-session")
FASTAPI_BASE_URL = os.environ.get("FASTAPI_BASE_URL", "http://localhost:8000")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _trigger_n8n_session(snapshot: SessionSnapshot) -> None:
    payload = {
        "session_id": snapshot.session_id,
        "query": snapshot.query,
        "budget_cap_usd": snapshot.budget.cap_usd,
        "max_subquestions": snapshot.settings.max_subquestions,
        "max_papers_per_subquestion": snapshot.settings.max_papers_per_subquestion,
        "max_chunks_per_paper": snapshot.settings.max_chunks_per_paper,
        "fastapi_webhook_url": f"{FASTAPI_BASE_URL.rstrip('/')}/api/webhook/session-update",
    }
    async with httpx.AsyncClient() as client:
        response = await client.post(
            N8N_WEBHOOK_URL,
            json=payload,
            timeout=10.0,
        )
        response.raise_for_status()


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.post("/api/session", response_model=CreateSessionResponse)
async def create_session(body: CreateSessionRequest) -> CreateSessionResponse:
    session_id = f"sess_{uuid.uuid4().hex[:8]}"
    snapshot = SessionSnapshot(
        session_id=session_id,
        query=body.query,
        status="queued",
        active_stage="created",
        budget=BudgetState(
            cap_usd=body.budget_cap_usd,
            spent_usd=0.0,
            remaining_usd=body.budget_cap_usd,
            estimated_next_step_usd=0.0,
        ),
        settings=ResearchSettings(
            max_subquestions=body.max_subquestions,
            max_papers_per_subquestion=body.max_papers_per_subquestion,
            max_chunks_per_paper=body.max_chunks_per_paper,
        ),
        graph=GraphSnapshot(),
        created_at=_now(),
        updated_at=_now(),
    )
    sessions[session_id] = snapshot
    try:
        await _trigger_n8n_session(snapshot)
    except httpx.HTTPError as exc:
        sessions.pop(session_id, None)
        raise HTTPException(status_code=502, detail=f"Failed to trigger n8n workflow: {exc}") from exc
    return CreateSessionResponse(
        session_id=session_id,
        status="queued",
        stream_url=f"/api/session/{session_id}/stream",
        snapshot=snapshot,
    )


@app.get("/api/session/{session_id}", response_model=SessionSnapshot)
async def get_session(session_id: str) -> SessionSnapshot:
    snap = sessions.get(session_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return snap


@app.get("/api/session/{session_id}/stream")
async def stream_session(session_id: str) -> StreamingResponse:
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    q = stream_manager.subscribe(session_id)

    async def event_generator():
        try:
            # Push current snapshot immediately on connect
            snap = sessions[session_id]
            initial = SessionUpdateEvent(type="session_updated", session_id=session_id, snapshot=snap)
            yield f"data: {initial.model_dump_json()}\n\n"

            while True:
                try:
                    message = await asyncio.wait_for(q.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if message is None:  # sentinel — session finished
                    break
                yield message
        finally:
            stream_manager.unsubscribe(session_id, q)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/webhook/session-update")
async def webhook_session_update(body: WebhookUpdateRequest):
    try:
        await apply_webhook_update(body, sessions)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"ok": True}
