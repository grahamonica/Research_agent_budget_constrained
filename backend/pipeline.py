"""Purpose: Orchestrate a research session end to end and emit step updates into the session state pipeline."""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Awaitable, Callable

import httpx

from .budget import BudgetTracker, compute_openai_cost
from .memory import SessionMemory
from .models import (
    BudgetState,
    FindingCard,
    FinalAnswer,
    GraphEdge,
    GraphNode,
    GraphPatch,
    SessionEvent,
    SessionSnapshot,
    Subquestion,
    WebhookUpdateRequest,
)
from .retrieval import retrieve_top_papers

OPENAI_API_KEY = os.environ.get("OPEN_AI_API_KEY", "")
GPT4O = "gpt-4o"

UpdateFn = Callable[[WebhookUpdateRequest, dict], Awaitable[SessionSnapshot]]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _evt(stage: str, message: str) -> SessionEvent:
    return SessionEvent(id=f"evt_{uuid.uuid4().hex[:8]}", stage=stage, message=message, created_at=_now())


async def _chat(messages: list[dict], max_tokens: int = 512) -> tuple[str, int, int]:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            json={"model": GPT4O, "messages": messages, "max_tokens": max_tokens, "temperature": 0.3},
            timeout=60.0,
        )
        resp.raise_for_status()
    data = resp.json()
    usage = data.get("usage", {})
    return data["choices"][0]["message"]["content"], usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)


async def _post(on_update: UpdateFn, req: WebhookUpdateRequest, sessions: dict) -> None:
    await on_update(req, sessions)


async def run_pipeline(
    snapshot: SessionSnapshot,
    sessions: dict,
    on_update: UpdateFn,
) -> None:
    """Run the full research pipeline, calling on_update at each stage."""
    sid = snapshot.session_id
    budget = BudgetTracker(snapshot.budget.cap_usd)
    memory = SessionMemory()
    max_sq = 3

    # ── Stage 1: Decompose ──────────────────────────────────────────────────────
    budget.set_next_step_estimate("decompose")
    await _post(on_update, WebhookUpdateRequest(
        session_id=sid, status="running", active_stage="decomposing",
        event=_evt("planning", "Decomposing query into subquestions."),
        budget=budget.get_state(),
    ), sessions)

    raw, in_tok, out_tok = await _chat([
        {"role": "system", "content": f"Break the research question into {max_sq} focused subquestions. Return ONLY a JSON array of strings."},
        {"role": "user", "content": snapshot.query},
    ], max_tokens=300)
    budget.record_spend(compute_openai_cost(GPT4O, in_tok, out_tok))

    try:
        sq_texts = json.loads(raw)
        if not isinstance(sq_texts, list):
            raise ValueError
    except Exception:
        sq_texts = [snapshot.query]
    sq_texts = [str(t) for t in sq_texts[:max_sq]]

    subquestions = [Subquestion(id=f"sq_{i}", text=t) for i, t in enumerate(sq_texts)]

    query_node = GraphNode(id="q_0", label=snapshot.query[:60], type="query", status="completed")
    sq_nodes = [GraphNode(id=sq.id, label=sq.text[:60], type="subquestion") for sq in subquestions]
    sq_edges = [GraphEdge(id=f"e_q_{sq.id}", source="q_0", target=sq.id, type="decomposes_to") for sq in subquestions]

    budget.set_next_step_estimate("embed_subquestion")
    await _post(on_update, WebhookUpdateRequest(
        session_id=sid, status="running", active_stage="planning",
        event=_evt("planning", f"Identified {len(subquestions)} subquestions."),
        graph_patch=GraphPatch(nodes=[query_node] + sq_nodes, edges=sq_edges),
        budget=budget.get_state(),
    ), sessions)

    # ── Stage 2: Retrieve and extract per subquestion ──────────────────────────
    all_findings: list[FindingCard] = []

    for sq in subquestions:
        if budget.is_over_limit():
            break

        sq_active = GraphNode(id=sq.id, label=sq.text[:60], type="subquestion", status="active")
        await _post(on_update, WebhookUpdateRequest(
            session_id=sid, status="running", active_stage="retrieving",
            event=_evt("retrieval", f"Retrieving papers for: {sq.text[:80]}"),
            graph_patch=GraphPatch(nodes=[sq_active]),
            budget=budget.get_state(),
        ), sessions)

        papers = await retrieve_top_papers(sq.text, max_papers=3, max_chunks=3)
        budget.record_spend(0.0002)  # nominal embedding cost

        paper_nodes = [
            GraphNode(id=p["id"], label=p["title"][:60], type="paper", status="active",
                      score=p["score"], metadata={"title": p["title"]})
            for p in papers
        ]
        paper_edges = [
            GraphEdge(id=f"e_{sq.id}_{p['id']}", source=sq.id, target=p["id"], type="retrieves")
            for p in papers
        ]
        await _post(on_update, WebhookUpdateRequest(
            session_id=sid, status="running", active_stage="retrieving",
            event=_evt("retrieval", f"Retrieved {len(papers)} papers."),
            graph_patch=GraphPatch(nodes=paper_nodes, edges=paper_edges),
            budget=budget.get_state(),
        ), sessions)

        if budget.is_near_limit():
            sq_done = GraphNode(id=sq.id, label=sq.text[:60], type="subquestion", status="completed")
            await _post(on_update, WebhookUpdateRequest(
                session_id=sid, status="running", active_stage="retrieving",
                event=_evt("retrieval", "Skipping LLM extraction to stay within budget."),
                graph_patch=GraphPatch(nodes=[sq_done]),
                budget=budget.get_state(),
            ), sessions)
            continue

        context = "\n\n".join(
            f"Paper: {p['title']}\n" + "\n".join(p["chunks"]) for p in papers
        )
        budget.set_next_step_estimate("extract_findings")
        raw_f, in_tok, out_tok = await _chat([
            {"role": "system", "content": (
                "Extract 2-3 concise factual findings from the text. "
                "Return a JSON array of objects: [{\"claim\": str, \"source_ids\": [str], \"confidence\": float}]"
            )},
            {"role": "user", "content": f"Subquestion: {sq.text}\n\nContext:\n{context}"},
        ], max_tokens=400)
        budget.record_spend(compute_openai_cost(GPT4O, in_tok, out_tok))

        try:
            findings_raw = json.loads(raw_f)
            if not isinstance(findings_raw, list):
                raise ValueError
        except Exception:
            findings_raw = []

        new_findings: list[FindingCard] = []
        finding_nodes: list[GraphNode] = []
        finding_edges: list[GraphEdge] = []

        for i, fr in enumerate(findings_raw[:3]):
            fid = f"f_{sq.id}_{i}"
            finding = FindingCard(
                id=fid,
                subquestion_id=sq.id,
                claim=str(fr.get("claim", "")),
                source_ids=fr.get("source_ids") or ([papers[0]["id"]] if papers else []),
                confidence=float(fr.get("confidence", 0.7)),
                created_at=_now(),
            )
            memory.add_finding(finding)
            all_findings.append(finding)
            new_findings.append(finding)
            finding_nodes.append(GraphNode(id=fid, label=finding.claim[:60], type="finding", status="completed", score=finding.confidence))
            if finding.source_ids:
                finding_edges.append(GraphEdge(id=f"e_{finding.source_ids[0]}_{fid}", source=finding.source_ids[0], target=fid, type="supports", weight=finding.confidence))

        sq_done = GraphNode(id=sq.id, label=sq.text[:60], type="subquestion", status="completed")
        await _post(on_update, WebhookUpdateRequest(
            session_id=sid, status="running", active_stage="extracting",
            event=_evt("extraction", f"Extracted {len(new_findings)} findings."),
            graph_patch=GraphPatch(nodes=[sq_done] + finding_nodes, edges=finding_edges),
            new_findings=new_findings,
            budget=budget.get_state(),
        ), sessions)

    # ── Stage 3: Synthesize ─────────────────────────────────────────────────────
    retained = memory.get_findings()

    if not retained or budget.is_over_limit():
        final = FinalAnswer(text="Insufficient budget or findings to synthesize a full answer.", citations=[], uncertainty="high")
        status = "partial"
    else:
        findings_text = "\n".join(f"- [{f.confidence:.2f}] {f.claim}" for f in retained)
        budget.set_next_step_estimate("synthesize")
        raw_s, in_tok, out_tok = await _chat([
            {"role": "system", "content": (
                "Synthesize a concise research answer grounded in the findings. "
                "Return JSON: {\"text\": str, \"citations\": [finding_id], \"uncertainty\": \"low\"|\"medium\"|\"high\"}"
            )},
            {"role": "user", "content": f"Query: {snapshot.query}\n\nFindings:\n{findings_text}"},
        ], max_tokens=600)
        budget.record_spend(compute_openai_cost(GPT4O, in_tok, out_tok))

        try:
            synth = json.loads(raw_s)
            final = FinalAnswer(
                text=synth.get("text", raw_s),
                citations=synth.get("citations", [f.id for f in retained]),
                uncertainty=synth.get("uncertainty", "medium"),
            )
        except Exception:
            final = FinalAnswer(text=raw_s, citations=[f.id for f in retained], uncertainty="medium")

        status = "completed"

    final_node = GraphNode(id="final_0", label="Final Answer", type="final", status="completed")
    final_edges = [GraphEdge(id=f"e_{f.id}_final", source=f.id, target="final_0", type="supports", weight=f.confidence) for f in retained[:5]]

    await _post(on_update, WebhookUpdateRequest(
        session_id=sid, status=status, active_stage="completed",
        event=_evt("synthesis", "Research complete. Final answer synthesized."),
        graph_patch=GraphPatch(nodes=[final_node], edges=final_edges),
        final_answer=final,
        budget=budget.get_state(),
    ), sessions)
