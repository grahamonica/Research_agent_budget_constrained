import pytest

from backend.models import (
    BudgetState,
    FinalAnswer,
    FindingCard,
    GraphEdge,
    GraphNode,
    GraphPatch,
    GraphSnapshot,
    SessionEvent,
    SessionSnapshot,
    WebhookUpdateRequest,
)
from backend.webhooks import apply_webhook_update


def make_snapshot() -> SessionSnapshot:
    return SessionSnapshot(
        session_id="sess_123",
        query="What are the limitations of RAG?",
        status="queued",
        active_stage="created",
        budget=BudgetState(
            cap_usd=0.05,
            spent_usd=0.0,
            remaining_usd=0.05,
            estimated_next_step_usd=0.0,
        ),
        graph=GraphSnapshot(),
        created_at="2026-04-05T14:00:00Z",
        updated_at="2026-04-05T14:00:00Z",
    )


@pytest.mark.asyncio
async def test_apply_webhook_update_merges_graph_findings_and_final_answer() -> None:
    sessions = {"sess_123": make_snapshot()}
    request = WebhookUpdateRequest(
        session_id="sess_123",
        status="completed",
        active_stage="completed",
        event=SessionEvent(
            id="evt_1",
            stage="synthesis",
            message="Final answer ready.",
            created_at="2026-04-05T14:10:00Z",
        ),
        graph_patch=GraphPatch(
            nodes=[
                GraphNode(
                    id="paper_1",
                    label="Paper A",
                    type="paper",
                    status="completed",
                    score=0.8,
                    metadata={},
                )
            ],
            edges=[
                GraphEdge(
                    id="edge_1",
                    source="sq_1",
                    target="paper_1",
                    type="retrieves",
                    weight=0.8,
                )
            ],
        ),
        new_findings=[
            FindingCard(
                id="finding_1",
                subquestion_id="sq_1",
                claim="Retrieval misses reduce completeness.",
                source_ids=["paper_1"],
                confidence=0.83,
                created_at="2026-04-05T14:09:00Z",
            )
        ],
        budget=BudgetState(
            cap_usd=0.05,
            spent_usd=0.02,
            remaining_usd=0.03,
            estimated_next_step_usd=0.0,
        ),
        final_answer=FinalAnswer(
            text="RAG is limited by retrieval quality.",
            citations=["finding_1"],
            uncertainty="medium",
        ),
    )

    updated = await apply_webhook_update(request, sessions)

    assert updated.status == "completed"
    assert updated.active_stage == "completed"
    assert updated.budget.spent_usd == 0.02
    assert len(updated.events) == 1
    assert len(updated.graph.nodes) == 1
    assert len(updated.graph.edges) == 1
    assert len(updated.findings) == 1
    assert updated.final_answer is not None
    assert updated.final_answer.text == "RAG is limited by retrieval quality."


@pytest.mark.asyncio
async def test_apply_webhook_update_rejects_missing_session() -> None:
    request = WebhookUpdateRequest(
        session_id="missing",
        status="running",
        active_stage="retrieving",
    )

    with pytest.raises(KeyError):
        await apply_webhook_update(request, {})
