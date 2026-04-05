import pytest

from backend.models import (
    BudgetState,
    GraphSnapshot,
    SessionSnapshot,
    SessionUpdateEvent,
)
from backend.streaming import StreamManager


def make_snapshot() -> SessionSnapshot:
    return SessionSnapshot(
        session_id="sess_stream",
        query="Test query",
        status="running",
        active_stage="retrieving",
        budget=BudgetState(
            cap_usd=0.05,
            spent_usd=0.01,
            remaining_usd=0.04,
            estimated_next_step_usd=0.003,
        ),
        graph=GraphSnapshot(),
        created_at="2026-04-05T14:00:00Z",
        updated_at="2026-04-05T14:00:00Z",
    )


@pytest.mark.asyncio
async def test_stream_manager_publishes_and_closes_session() -> None:
    manager = StreamManager()
    queue = manager.subscribe("sess_stream")

    event = SessionUpdateEvent(
        type="session_updated",
        session_id="sess_stream",
        snapshot=make_snapshot(),
    )

    await manager.publish("sess_stream", event)
    payload = await queue.get()

    assert payload is not None
    assert '"session_id":"sess_stream"' in payload
    assert payload.startswith("data: ")

    await manager.close_session("sess_stream")
    sentinel = await queue.get()

    assert sentinel is None
