"""Purpose: Define typed models for sessions, snapshots, webhook updates, findings, graph state, and final answers."""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class BudgetState(BaseModel):
    cap_usd: float
    spent_usd: float = 0.0
    remaining_usd: float
    estimated_next_step_usd: float = 0.0


class Subquestion(BaseModel):
    id: str
    text: str
    status: Literal["pending", "running", "completed", "partial"] = "pending"


class GraphNode(BaseModel):
    id: str
    label: str
    type: Literal["query", "subquestion", "category", "paper", "finding", "final"]
    status: Literal["idle", "active", "completed", "discarded"] = "idle"
    score: Optional[float] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    type: Literal["decomposes_to", "routes_to", "retrieves", "supports"]
    weight: Optional[float] = None


class GraphSnapshot(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)


class GraphPatch(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)


class FindingCard(BaseModel):
    id: str
    subquestion_id: str
    claim: str
    source_ids: list[str]
    confidence: float
    created_at: str


class FinalAnswer(BaseModel):
    text: str
    citations: list[str]
    uncertainty: str


class SessionEvent(BaseModel):
    id: str
    stage: str
    message: str
    created_at: str


class SessionSnapshot(BaseModel):
    session_id: str
    query: str
    status: Literal["queued", "running", "completed", "partial", "failed"]
    active_stage: str
    budget: BudgetState
    subquestions: list[Subquestion] = Field(default_factory=list)
    graph: GraphSnapshot = Field(default_factory=GraphSnapshot)
    findings: list[FindingCard] = Field(default_factory=list)
    final_answer: Optional[FinalAnswer] = None
    events: list[SessionEvent] = Field(default_factory=list)
    created_at: str
    updated_at: str


class CreateSessionRequest(BaseModel):
    query: str
    budget_cap_usd: float = 0.05
    max_subquestions: int = 3
    max_papers_per_subquestion: int = 3
    max_chunks_per_paper: int = 3


class CreateSessionResponse(BaseModel):
    session_id: str
    status: str
    stream_url: str
    snapshot: SessionSnapshot


class SessionUpdateEvent(BaseModel):
    type: Literal["session_updated", "session_completed", "session_failed"]
    session_id: str
    snapshot: SessionSnapshot


class WebhookUpdateRequest(BaseModel):
    session_id: str
    status: Literal["queued", "running", "completed", "partial", "failed"]
    active_stage: str
    event: Optional[SessionEvent] = None
    graph_patch: Optional[GraphPatch] = None
    new_findings: list[FindingCard] = Field(default_factory=list)
    budget: Optional[BudgetState] = None
    final_answer: Optional[FinalAnswer] = None
