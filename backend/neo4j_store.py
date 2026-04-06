"""Purpose: Async Neo4j store — persists graph nodes and edges after each pipeline patch, falls back gracefully when Neo4j is unavailable."""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import GraphEdge, GraphNode

logger = logging.getLogger(__name__)

NEO4J_URI = os.environ.get("NEO4J_URI", "")
NEO4J_USERNAME = os.environ.get("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")

_driver = None
_driver_failed = False  # Stop retrying after a failed init


def _get_driver():
    global _driver, _driver_failed
    if _driver_failed:
        return None
    if _driver is not None:
        return _driver
    if not NEO4J_URI or not NEO4J_PASSWORD:
        return None
    try:
        from neo4j import AsyncGraphDatabase  # type: ignore
        _driver = AsyncGraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USERNAME, NEO4J_PASSWORD))
        logger.info("Neo4j driver connected to %s", NEO4J_URI)
    except Exception as exc:
        logger.warning("Neo4j unavailable — graph will be in-memory only: %s", exc)
        _driver_failed = True
    return _driver


async def sync_graph_patch(session_id: str, nodes: list[GraphNode], edges: list[GraphEdge]) -> None:
    """Upsert nodes and edges into Neo4j. Silent no-op if Neo4j is not configured."""
    driver = _get_driver()
    if driver is None:
        return

    try:
        async with driver.session() as neo4j_session:
            for node in nodes:
                await neo4j_session.run(
                    """
                    MERGE (n:ResearchNode {id: $id, session_id: $session_id})
                    SET n.label    = $label,
                        n.type     = $type,
                        n.status   = $status,
                        n.score    = $score
                    """,
                    id=node.id,
                    session_id=session_id,
                    label=node.label,
                    type=node.type,
                    status=node.status,
                    score=node.score,
                )
            for edge in edges:
                await neo4j_session.run(
                    """
                    MATCH (src:ResearchNode {id: $source, session_id: $sid})
                    MATCH (tgt:ResearchNode {id: $target, session_id: $sid})
                    MERGE (src)-[r:CONNECTS {id: $id}]->(tgt)
                    SET r.type   = $type,
                        r.weight = $weight
                    """,
                    id=edge.id,
                    source=edge.source,
                    target=edge.target,
                    sid=session_id,
                    type=edge.type,
                    weight=edge.weight,
                )
    except Exception as exc:
        logger.warning("Neo4j sync failed for session %s: %s", session_id, exc)
