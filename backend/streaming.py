"""Purpose: Publish live session updates from FastAPI to the React frontend through a streaming interface."""

from __future__ import annotations

import asyncio
from collections import defaultdict

from .models import SessionUpdateEvent


class StreamManager:
    def __init__(self) -> None:
        self._queues: dict[str, list[asyncio.Queue[str | None]]] = defaultdict(list)

    def subscribe(self, session_id: str) -> asyncio.Queue[str | None]:
        q: asyncio.Queue[str | None] = asyncio.Queue()
        self._queues[session_id].append(q)
        return q

    def unsubscribe(self, session_id: str, q: asyncio.Queue[str | None]) -> None:
        try:
            self._queues[session_id].remove(q)
        except (KeyError, ValueError):
            pass

    async def publish(self, session_id: str, event: SessionUpdateEvent) -> None:
        payload = f"data: {event.model_dump_json()}\n\n"
        for q in list(self._queues.get(session_id, [])):
            await q.put(payload)

    async def close_session(self, session_id: str) -> None:
        """Send sentinel None to all subscribers so they know the stream ended."""
        for q in list(self._queues.get(session_id, [])):
            await q.put(None)
        self._queues.pop(session_id, None)


stream_manager = StreamManager()
