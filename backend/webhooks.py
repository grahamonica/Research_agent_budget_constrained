"""Purpose: Handle inbound workflow webhook payloads that update session state inside FastAPI."""

from __future__ import annotations

from datetime import datetime, timezone

from .models import SessionSnapshot, SessionUpdateEvent, WebhookUpdateRequest
from .streaming import stream_manager


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def apply_webhook_update(
    req: WebhookUpdateRequest,
    sessions: dict[str, SessionSnapshot],
) -> SessionSnapshot:
    """Merge the webhook payload into the stored session snapshot and push an SSE event."""
    snap = sessions.get(req.session_id)
    if snap is None:
        raise KeyError(f"Session {req.session_id!r} not found")

    snap.status = req.status
    snap.active_stage = req.active_stage
    snap.updated_at = _now()

    if req.budget is not None:
        snap.budget = req.budget

    if req.event is not None:
        snap.events.append(req.event)

    if req.subquestions:
        snap.subquestions = req.subquestions

    if req.graph_patch is not None:
        node_index = {n.id: i for i, n in enumerate(snap.graph.nodes)}
        for node in req.graph_patch.nodes:
            if node.id in node_index:
                snap.graph.nodes[node_index[node.id]] = node
            else:
                snap.graph.nodes.append(node)
                node_index[node.id] = len(snap.graph.nodes) - 1

        existing_edge_ids = {e.id for e in snap.graph.edges}
        for edge in req.graph_patch.edges:
            if edge.id not in existing_edge_ids:
                snap.graph.edges.append(edge)
                existing_edge_ids.add(edge.id)

    existing_finding_ids = {f.id for f in snap.findings}
    for finding in req.new_findings:
        if finding.id not in existing_finding_ids:
            snap.findings.append(finding)
            existing_finding_ids.add(finding.id)

    if req.final_answer is not None:
        snap.final_answer = req.final_answer

    sessions[req.session_id] = snap

    if snap.status == "completed":
        event_type = "session_completed"
    elif snap.status == "failed":
        event_type = "session_failed"
    else:
        event_type = "session_updated"

    sse_event = SessionUpdateEvent(type=event_type, session_id=snap.session_id, snapshot=snap)
    await stream_manager.publish(snap.session_id, sse_event)

    if snap.status in ("completed", "partial", "failed"):
        await stream_manager.close_session(snap.session_id)

    return snap
