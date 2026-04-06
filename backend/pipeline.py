"""Purpose: Orchestrate a research session end to end and emit step updates into the session state pipeline."""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx

from .budget import BudgetTracker, compute_openai_cost, estimate_step_cost
from .memory import SessionMemory
from .models import (
    FinalAnswer,
    FindingCard,
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
TEST_MODE = os.environ.get("RESEARCH_AGENT_TEST_MODE", "").lower() in {"1", "true", "yes"}

UpdateFn = Callable[[WebhookUpdateRequest, dict], Awaitable[SessionSnapshot]]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _strip_json(text: str) -> str:
    """Strip markdown code fences that GPT-4o wraps around JSON responses."""
    text = text.strip()
    match = re.match(r"^```(?:json)?\s*\n?(.*?)\n?```$", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return text


def _clip(text: str, limit: int = 60) -> str:
    return text.strip()[:limit] if text else ""


def _evt(stage: str, message: str) -> SessionEvent:
    return SessionEvent(id=f"evt_{uuid.uuid4().hex[:8]}", stage=stage, message=message, created_at=_now())


def _claim_from_chunk(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip().rstrip(".")
    parts = re.split(r"(?<=[.!?])\s+", cleaned)
    sentence = parts[0] if parts else cleaned
    sentence = sentence.strip().rstrip(".")
    return sentence + "." if sentence else ""


def _source_edges(target_id: str, source_ids: list[str], confidence: float) -> list[GraphEdge]:
    return [
        GraphEdge(
            id=f"e_{source_id}_{target_id}",
            source=source_id,
            target=target_id,
            type="supports",
            weight=confidence,
        )
        for source_id in source_ids
    ]


def _subquestion_state(
    subquestions: list[Subquestion],
    *,
    active_id: str | None = None,
    completed_ids: set[str] | None = None,
    partial_ids: set[str] | None = None,
) -> list[Subquestion]:
    completed_ids = completed_ids or set()
    partial_ids = partial_ids or set()
    updated: list[Subquestion] = []
    for sq in subquestions:
        status = "pending"
        if sq.id == active_id:
            status = "running"
        elif sq.id in completed_ids:
            status = "completed"
        elif sq.id in partial_ids:
            status = "partial"
        updated.append(Subquestion(id=sq.id, text=sq.text, status=status))
    return updated


def _coerce_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _dedupe_findings(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for item in items:
        claim = re.sub(r"\s+", " ", str(item.get("claim", "")).strip()).lower()
        if not claim or claim in seen:
            continue
        seen.add(claim)
        deduped.append(item)
    return deduped


def _build_seed_findings(
    sq: Subquestion,
    papers: list[dict[str, Any]],
    limit: int,
) -> list[dict[str, Any]]:
    seeds: list[dict[str, Any]] = []
    for idx, paper in enumerate(papers[:limit]):
        chunks = paper.get("chunks") or []
        if not chunks:
            continue
        claim = _claim_from_chunk(str(chunks[0]))
        if not claim:
            continue
        seeds.append({
            "candidate_id": f"seed_{sq.id}_{idx}",
            "claim": claim,
            "source_ids": [paper["id"]],
            "confidence": round(max(0.42, min(0.88, 0.38 + _coerce_float(paper.get("score"), 0.0) * 0.62)), 2),
        })
    return seeds


def _diagnostic_finding(sq: Subquestion, papers: list[dict[str, Any]]) -> dict[str, Any]:
    if not papers:
        return {
            "claim": "No candidate papers were retrieved for this subquestion in the local corpus.",
            "source_ids": [],
            "confidence": 0.25,
        }
    top_score = _coerce_float(papers[0].get("score"), 0.0)
    if top_score < 0.22:
        return {
            "claim": "The local paper corpus did not contain strong direct matches for this subquestion.",
            "source_ids": [paper["id"] for paper in papers[:2]],
            "confidence": 0.32,
        }
    return {
        "claim": f"Evidence for this subquestion was thin and concentrated in {_clip(str(papers[0].get('title', 'one paper')), 48)}.",
        "source_ids": [paper["id"] for paper in papers[:2]],
        "confidence": 0.4,
    }


def _synthetic_usage(step: str) -> tuple[int, int]:
    if step == "decompose":
        return 420, 220
    if step == "extract":
        return 950, 260
    if step == "synthesize":
        return 1200, 320
    return 0, 0


def _test_decompose_query(query: str, max_subquestions: int) -> list[str]:
    topic = query.strip().rstrip("?.!")
    lowered = topic[:1].lower() + topic[1:] if topic else "the research question"
    candidates = [
        f"What mechanisms or drivers explain {lowered}?",
        f"Which papers provide the strongest direct evidence about {lowered}?",
        f"What trade-offs, uncertainties, or failure modes shape {lowered}?",
    ]
    return candidates[:max_subquestions]


def _candidate_ids_for_sources(seed_findings: list[dict[str, Any]], source_ids: list[str]) -> list[str]:
    return [
        seed["candidate_id"]
        for seed in seed_findings
        if any(source_id in seed.get("source_ids", []) for source_id in source_ids)
    ]


def _test_extract_findings(
    sq: Subquestion,
    papers: list[dict[str, Any]],
    seed_findings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    extracted: list[dict[str, Any]] = []
    for paper in papers[:3]:
        chunks = paper.get("chunks") or []
        if not chunks:
            continue
        extracted.append({
            "claim": _claim_from_chunk(str(chunks[0])),
            "source_ids": [paper["id"]],
            "confidence": round(max(0.55, min(0.91, _coerce_float(paper.get("score"), 0.0) + 0.18)), 2),
            "candidate_ids": _candidate_ids_for_sources(seed_findings, [paper["id"]]),
        })
    if not extracted:
        extracted.append(_diagnostic_finding(sq, papers))
    return extracted[:3]


def _test_synthesize(query: str, findings: list[FindingCard]) -> FinalAnswer:
    ranked = sorted(findings, key=lambda item: item.confidence, reverse=True)
    citations = [finding.id for finding in ranked[:3]]
    if not ranked:
        return FinalAnswer(
            text="The run completed without retaining enough evidence to synthesize a grounded answer.",
            citations=[],
            uncertainty="high",
        )
    top_claims = [finding.claim for finding in ranked[:3]]
    confidence = sum(finding.confidence for finding in ranked[:3]) / min(len(ranked), 3)
    uncertainty = "low" if confidence >= 0.8 else "medium" if confidence >= 0.6 else "high"
    text = f"{query.rstrip('?.!')}: {' '.join(top_claims)}"
    return FinalAnswer(text=text, citations=citations, uncertainty=uncertainty)


async def _chat(messages: list[dict[str, str]], max_tokens: int = 512) -> tuple[str, int, int]:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPEN_AI_API_KEY is required for live research runs.")
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
    settings = snapshot.settings
    budget = BudgetTracker(snapshot.budget.cap_usd)
    memory = SessionMemory()
    completed_sq_ids: set[str] = set()
    partial_sq_ids: set[str] = set()
    subquestions: list[Subquestion] = []

    try:
        # ── Stage 1: Decompose ────────────────────────────────────────────────
        budget.activate("decompose")
        budget.set_next_step_estimate("decompose", "decompose")
        await _post(on_update, WebhookUpdateRequest(
            session_id=sid,
            status="running",
            active_stage="decomposing",
            event=_evt("planning", "Decomposing query into subquestions."),
            budget=budget.get_state(),
        ), sessions)

        if TEST_MODE:
            sq_texts = _test_decompose_query(snapshot.query, settings.max_subquestions)
            in_tok, out_tok = _synthetic_usage("decompose")
        else:
            raw, in_tok, out_tok = await _chat([
                {
                    "role": "system",
                    "content": (
                        f"Break the research question into {settings.max_subquestions} focused subquestions. "
                        "Return ONLY a JSON array of strings."
                    ),
                },
                {"role": "user", "content": snapshot.query},
            ], max_tokens=320)
            parsed = json.loads(_strip_json(raw))
            if not isinstance(parsed, list):
                raise RuntimeError("Decomposition response was not a JSON array.")
            sq_texts = parsed
        budget.record_spend(compute_openai_cost(GPT4O, in_tok, out_tok), "decompose")

        sq_texts = [str(text).strip() for text in sq_texts if str(text).strip()][: settings.max_subquestions]
        if not sq_texts:
            raise RuntimeError("Decomposition produced no subquestions.")

        subquestions = [Subquestion(id=f"sq_{idx}", text=text) for idx, text in enumerate(sq_texts)]
        budget.complete("decompose")
        budget.plan_research([sq.id for sq in subquestions])

        query_node = GraphNode(
            id="q_0",
            label=_clip(snapshot.query),
            type="query",
            status="completed",
            metadata={"query": snapshot.query},
        )
        sq_nodes = [
            GraphNode(
                id=sq.id,
                label=_clip(sq.text),
                type="subquestion",
                status="idle",
                metadata={"subquestion": sq.text},
            )
            for sq in subquestions
        ]
        sq_edges = [
            GraphEdge(id=f"e_q_{sq.id}", source="q_0", target=sq.id, type="decomposes_to")
            for sq in subquestions
        ]

        await _post(on_update, WebhookUpdateRequest(
            session_id=sid,
            status="running",
            active_stage="planning",
            event=_evt("planning", f"Allocated explicit sub-budgets across {len(subquestions)} subquestions."),
            graph_patch=GraphPatch(nodes=[query_node] + sq_nodes, edges=sq_edges),
            subquestions=_subquestion_state(subquestions),
            budget=budget.get_state(),
        ), sessions)

        # ── Stage 2: Explore papers and retain findings per subquestion ──────
        for sq in subquestions:
            if budget.is_over_limit():
                partial_sq_ids.add(sq.id)
                break

            retrieve_key = f"retrieve:{sq.id}"
            extract_key = f"extract:{sq.id}"

            budget.activate(retrieve_key)
            budget.set_next_step_estimate("retrieve", retrieve_key)
            await _post(on_update, WebhookUpdateRequest(
                session_id=sid,
                status="running",
                active_stage="retrieving",
                event=_evt(
                    "retrieval",
                    f"Exploring the paper neighborhood for: {sq.text[:80]}",
                ),
                graph_patch=GraphPatch(nodes=[
                    GraphNode(id=sq.id, label=_clip(sq.text), type="subquestion", status="active", metadata={"subquestion": sq.text}),
                ]),
                subquestions=_subquestion_state(subquestions, active_id=sq.id, completed_ids=completed_sq_ids, partial_ids=partial_sq_ids),
                budget=budget.get_state(),
            ), sessions)

            retrieval_budget = budget.available_for(retrieve_key)
            exploration_width = settings.max_papers_per_subquestion + (2 if retrieval_budget >= 0.005 else 1)
            chunk_limit = settings.max_chunks_per_paper + (1 if retrieval_budget >= 0.008 else 0)
            papers = await retrieve_top_papers(
                sq.text,
                max_papers=exploration_width,
                max_chunks=chunk_limit,
            )

            retrieval_spend = round(
                0.00025 + (0.00008 * len(papers)) + (0.00002 * sum(len(paper.get("chunks", [])) for paper in papers)),
                8,
            )
            budget.record_spend(retrieval_spend, retrieve_key)

            candidate_nodes = [
                GraphNode(
                    id=paper["id"],
                    label=_clip(str(paper.get("title", paper["id"]))),
                    type="paper",
                    status="active",
                    score=_coerce_float(paper.get("score"), 0.0),
                    metadata={
                        "title": paper.get("title", ""),
                        "rank": paper.get("rank"),
                        "lexical_score": paper.get("lexical_score"),
                        "branch": "candidate",
                    },
                )
                for paper in papers
            ]
            candidate_edges = [
                GraphEdge(
                    id=f"e_{sq.id}_{paper['id']}",
                    source=sq.id,
                    target=paper["id"],
                    type="retrieves",
                    weight=_coerce_float(paper.get("score"), 0.0),
                )
                for paper in papers
            ]

            await _post(on_update, WebhookUpdateRequest(
                session_id=sid,
                status="running",
                active_stage="retrieving",
                event=_evt("retrieval", f"Exploring {len(papers)} candidate papers for {sq.id}."),
                graph_patch=GraphPatch(nodes=candidate_nodes, edges=candidate_edges),
                subquestions=_subquestion_state(subquestions, active_id=sq.id, completed_ids=completed_sq_ids, partial_ids=partial_sq_ids),
                budget=budget.get_state(),
            ), sessions)

            keep_count = min(settings.max_papers_per_subquestion, len(papers))
            if retrieval_budget >= 0.01:
                keep_count = min(len(papers), keep_count + 1)
            if papers and _coerce_float(papers[0].get("score"), 0.0) < 0.22:
                keep_count = min(len(papers), max(2, keep_count))
            retained_papers = papers[:keep_count]
            pruned_papers = papers[keep_count:]

            prune_nodes = [
                GraphNode(
                    id=paper["id"],
                    label=_clip(str(paper.get("title", paper["id"]))),
                    type="paper",
                    status="discarded",
                    score=_coerce_float(paper.get("score"), 0.0),
                    metadata={
                        "title": paper.get("title", ""),
                        "rank": paper.get("rank"),
                        "lexical_score": paper.get("lexical_score"),
                        "branch": "pruned",
                    },
                )
                for paper in pruned_papers
            ] + [
                GraphNode(
                    id=paper["id"],
                    label=_clip(str(paper.get("title", paper["id"]))),
                    type="paper",
                    status="active",
                    score=_coerce_float(paper.get("score"), 0.0),
                    metadata={
                        "title": paper.get("title", ""),
                        "rank": paper.get("rank"),
                        "lexical_score": paper.get("lexical_score"),
                        "branch": "retained",
                    },
                )
                for paper in retained_papers
            ]

            await _post(on_update, WebhookUpdateRequest(
                session_id=sid,
                status="running",
                active_stage="retrieving",
                event=_evt(
                    "retrieval",
                    f"Pruned {len(pruned_papers)} paper branches and kept {len(retained_papers)} for deeper reading.",
                ),
                graph_patch=GraphPatch(nodes=prune_nodes),
                subquestions=_subquestion_state(subquestions, active_id=sq.id, completed_ids=completed_sq_ids, partial_ids=partial_sq_ids),
                budget=budget.get_state(),
            ), sessions)
            budget.complete(retrieve_key)

            budget.activate(extract_key)
            budget.set_next_step_estimate("extract", extract_key)

            seed_findings = _build_seed_findings(sq, retained_papers, limit=max(2, settings.max_papers_per_subquestion))
            seed_nodes = [
                GraphNode(
                    id=seed["candidate_id"],
                    label=_clip(seed["claim"]),
                    type="finding",
                    status="active",
                    score=_coerce_float(seed.get("confidence"), 0.5),
                    metadata={"phase": "candidate", "source_ids": seed["source_ids"]},
                )
                for seed in seed_findings
            ]
            seed_edges = [
                edge
                for seed in seed_findings
                for edge in _source_edges(seed["candidate_id"], seed["source_ids"], _coerce_float(seed.get("confidence"), 0.5))
            ]
            if seed_nodes:
                await _post(on_update, WebhookUpdateRequest(
                    session_id=sid,
                    status="running",
                    active_stage="extracting",
                    event=_evt("extraction", f"Drafted {len(seed_nodes)} candidate findings from retained papers."),
                    graph_patch=GraphPatch(nodes=seed_nodes, edges=seed_edges),
                    subquestions=_subquestion_state(subquestions, active_id=sq.id, completed_ids=completed_sq_ids, partial_ids=partial_sq_ids),
                    budget=budget.get_state(),
                ), sessions)

            extracted_raw: list[dict[str, Any]] = []
            extract_rounds = 2 if budget.available_for(extract_key) >= 0.01 and len(retained_papers) > 1 else 1
            for round_idx in range(extract_rounds):
                batch_start = round_idx
                batch = retained_papers[batch_start : batch_start + min(3, len(retained_papers))]
                if not batch:
                    continue
                if budget.available_for(extract_key) < max(estimate_step_cost("extract") * 0.30, 0.0015):
                    break
                context = "\n\n".join(
                    f"[{paper['id']}] {paper['title']}\n" + "\n".join(paper.get("chunks") or [])
                    for paper in batch
                )
                seed_text = "\n".join(
                    f"- [{seed['candidate_id']}] {seed['claim']} (sources: {', '.join(seed['source_ids'])})"
                    for seed in seed_findings
                ) or "- No seed findings drafted."

                if TEST_MODE:
                    parsed = _test_extract_findings(sq, batch, seed_findings)
                    in_tok, out_tok = _synthetic_usage("extract")
                else:
                    raw_f, in_tok, out_tok = await _chat([
                        {
                            "role": "system",
                            "content": (
                                "Extract up to 3 grounded findings from the shortlisted papers. "
                                "Return ONLY a JSON array of objects with keys: "
                                "{\"claim\": str, \"source_ids\": [paper_id], \"confidence\": float, \"candidate_ids\": [seed_id]}. "
                                "If the evidence is weak, return a diagnostic finding about weak corpus match instead of inventing facts."
                            ),
                        },
                        {
                            "role": "user",
                            "content": (
                                f"Subquestion: {sq.text}\n\n"
                                f"Candidate findings:\n{seed_text}\n\n"
                                f"Paper context:\n{context}"
                            ),
                        },
                    ], max_tokens=520)
                    parsed = json.loads(_strip_json(raw_f))
                    if not isinstance(parsed, list):
                        raise RuntimeError(f"Extraction response for {sq.id} was not a JSON array.")
                budget.record_spend(compute_openai_cost(GPT4O, in_tok, out_tok), extract_key)
                extracted_raw.extend([item for item in parsed if isinstance(item, dict)])

            merged_raw = _dedupe_findings(extracted_raw)
            if not merged_raw:
                merged_raw = [_diagnostic_finding(sq, papers)]

            new_findings: list[FindingCard] = []
            finding_nodes: list[GraphNode] = []
            finding_edges: list[GraphEdge] = []
            selected_candidate_ids = {
                candidate_id
                for finding in merged_raw
                for candidate_id in finding.get("candidate_ids", []) or []
            }

            seed_status_nodes = [
                GraphNode(
                    id=seed["candidate_id"],
                    label=_clip(seed["claim"]),
                    type="finding",
                    status="completed" if seed["candidate_id"] in selected_candidate_ids else "discarded",
                    score=_coerce_float(seed.get("confidence"), 0.5),
                    metadata={"phase": "candidate", "source_ids": seed["source_ids"]},
                )
                for seed in seed_findings
            ]

            for idx, raw_finding in enumerate(merged_raw[:3]):
                source_ids = [
                    source_id
                    for source_id in list(raw_finding.get("source_ids") or [])
                    if any(source_id == paper["id"] for paper in retained_papers + pruned_papers)
                ]
                if not source_ids and retained_papers:
                    source_ids = [retained_papers[min(idx, len(retained_papers) - 1)]["id"]]
                claim = _claim_from_chunk(str(raw_finding.get("claim", "")))
                if not claim:
                    continue
                confidence = round(_coerce_float(raw_finding.get("confidence"), 0.62), 2)
                finding = FindingCard(
                    id=f"f_{sq.id}_{idx}",
                    subquestion_id=sq.id,
                    claim=claim,
                    source_ids=source_ids,
                    confidence=confidence,
                    created_at=_now(),
                )
                memory.add_finding(finding)
                new_findings.append(finding)
                finding_nodes.append(GraphNode(
                    id=finding.id,
                    label=_clip(finding.claim),
                    type="finding",
                    status="completed",
                    score=finding.confidence,
                    metadata={"source_ids": finding.source_ids, "phase": "retained"},
                ))
                finding_edges.extend(_source_edges(finding.id, finding.source_ids, finding.confidence))

            if not new_findings:
                diagnostic = _diagnostic_finding(sq, papers)
                finding = FindingCard(
                    id=f"f_{sq.id}_0",
                    subquestion_id=sq.id,
                    claim=diagnostic["claim"],
                    source_ids=diagnostic["source_ids"],
                    confidence=diagnostic["confidence"],
                    created_at=_now(),
                )
                memory.add_finding(finding)
                new_findings.append(finding)
                finding_nodes.append(GraphNode(
                    id=finding.id,
                    label=_clip(finding.claim),
                    type="finding",
                    status="completed",
                    score=finding.confidence,
                    metadata={"source_ids": finding.source_ids, "phase": "retained"},
                ))
                finding_edges.extend(_source_edges(finding.id, finding.source_ids, finding.confidence))

            completed_sq_ids.add(sq.id)
            budget.complete(extract_key)

            await _post(on_update, WebhookUpdateRequest(
                session_id=sid,
                status="running",
                active_stage="extracting",
                event=_evt(
                    "extraction",
                    f"Retained {len(new_findings)} findings after pruning candidate branches for {sq.id}.",
                ),
                graph_patch=GraphPatch(
                    nodes=[
                        GraphNode(id=sq.id, label=_clip(sq.text), type="subquestion", status="completed", metadata={"subquestion": sq.text}),
                        *seed_status_nodes,
                        *finding_nodes,
                    ],
                    edges=finding_edges,
                ),
                subquestions=_subquestion_state(subquestions, completed_ids=completed_sq_ids, partial_ids=partial_sq_ids),
                new_findings=new_findings,
                budget=budget.get_state(),
            ), sessions)

        # ── Stage 2.5: Budget-driven expansion ───────────────────────────────────
        retained_so_far = memory.get_findings()
        budget_fraction_used = budget.spent_usd / max(budget.cap_usd, 1e-9)

        if (not budget.is_over_limit()
                and budget_fraction_used < 0.65
                and len(retained_so_far) >= 2):
            n_expand = 2 if budget_fraction_used < 0.40 else 1
            exp_topic = snapshot.query.strip().rstrip("?.!")

            if TEST_MODE:
                exp_texts: list[str] = [
                    f"What methodological limitations affect evidence on {exp_topic[:55]}?",
                    f"What practical implications does evidence on {exp_topic[:55]} suggest?",
                ][:n_expand]
            else:
                findings_summary = "\n".join(f"- {f.claim}" for f in retained_so_far[:5])
                raw_exp, in_tok_exp, out_tok_exp = await _chat([
                    {
                        "role": "system",
                        "content": (
                            f"Generate {n_expand} follow-up subquestion(s) that deepen research coverage. "
                            "Return ONLY a JSON array of strings."
                        ),
                    },
                    {
                        "role": "user",
                        "content": f"Query: {snapshot.query}\n\nInitial findings:\n{findings_summary}",
                    },
                ], max_tokens=180)
                exp_texts = json.loads(_strip_json(raw_exp))
                if not isinstance(exp_texts, list):
                    exp_texts = []
                budget.record_spend(compute_openai_cost(GPT4O, in_tok_exp, out_tok_exp), "synthesize")

            exp_base = len(subquestions)
            expansion_sqs = [
                Subquestion(id=f"sq_{exp_base + i}", text=str(t).strip())
                for i, t in enumerate(exp_texts[:n_expand])
                if str(t).strip()
            ]

            if expansion_sqs:
                synth_reserve = budget.cap_usd * 0.20
                expansion_pool = max(0.0, budget.cap_usd - budget.spent_usd - synth_reserve)
                per_exp = round(expansion_pool / max(len(expansion_sqs), 1), 6)
                for exp_sq in expansion_sqs:
                    budget._upsert_allocation(
                        f"retrieve:{exp_sq.id}", f"Expand retrieve {exp_sq.id}", round(per_exp * 0.42, 6)
                    )
                    budget._upsert_allocation(
                        f"extract:{exp_sq.id}", f"Expand extract {exp_sq.id}", round(per_exp * 0.58, 6)
                    )

                subquestions.extend(expansion_sqs)
                await _post(on_update, WebhookUpdateRequest(
                    session_id=sid,
                    status="running",
                    active_stage="expanding",
                    event=_evt("planning", f"Budget remaining — deepening with {len(expansion_sqs)} expansion subquestion(s)."),
                    graph_patch=GraphPatch(
                        nodes=[
                            GraphNode(
                                id=exp_sq.id, label=_clip(exp_sq.text), type="subquestion", status="idle",
                                metadata={"subquestion": exp_sq.text, "expansion": True},
                            )
                            for exp_sq in expansion_sqs
                        ],
                        edges=[
                            GraphEdge(id=f"e_q_{exp_sq.id}", source="q_0", target=exp_sq.id, type="decomposes_to")
                            for exp_sq in expansion_sqs
                        ],
                    ),
                    subquestions=_subquestion_state(subquestions, completed_ids=completed_sq_ids),
                    budget=budget.get_state(),
                ), sessions)

                for exp_sq in expansion_sqs:
                    if budget.is_over_limit():
                        partial_sq_ids.add(exp_sq.id)
                        break

                    exp_retrieve_key = f"retrieve:{exp_sq.id}"
                    exp_extract_key = f"extract:{exp_sq.id}"
                    budget.activate(exp_retrieve_key)
                    budget.set_next_step_estimate("retrieve", exp_retrieve_key)

                    await _post(on_update, WebhookUpdateRequest(
                        session_id=sid, status="running", active_stage="retrieving",
                        event=_evt("retrieval", f"Expanding into: {exp_sq.text[:80]}"),
                        graph_patch=GraphPatch(nodes=[
                            GraphNode(
                                id=exp_sq.id, label=_clip(exp_sq.text), type="subquestion", status="active",
                                metadata={"subquestion": exp_sq.text, "expansion": True},
                            )
                        ]),
                        subquestions=_subquestion_state(
                            subquestions, active_id=exp_sq.id,
                            completed_ids=completed_sq_ids, partial_ids=partial_sq_ids,
                        ),
                        budget=budget.get_state(),
                    ), sessions)

                    exp_papers = await retrieve_top_papers(
                        exp_sq.text,
                        max_papers=settings.max_papers_per_subquestion + 2,
                        max_chunks=settings.max_chunks_per_paper,
                    )
                    exp_retrieval_spend = round(
                        0.00025 + 0.00008 * len(exp_papers)
                        + 0.00002 * sum(len(p.get("chunks", [])) for p in exp_papers), 8
                    )
                    budget.record_spend(exp_retrieval_spend, exp_retrieve_key)

                    await _post(on_update, WebhookUpdateRequest(
                        session_id=sid, status="running", active_stage="retrieving",
                        event=_evt("retrieval", f"Found {len(exp_papers)} expansion candidates for {exp_sq.id}."),
                        graph_patch=GraphPatch(
                            nodes=[
                                GraphNode(
                                    id=p["id"], label=_clip(str(p.get("title", p["id"]))), type="paper",
                                    status="active", score=_coerce_float(p.get("score"), 0.0),
                                    metadata={"title": p.get("title", ""), "branch": "candidate"},
                                )
                                for p in exp_papers
                            ],
                            edges=[
                                GraphEdge(
                                    id=f"e_{exp_sq.id}_{p['id']}", source=exp_sq.id, target=p["id"],
                                    type="retrieves", weight=_coerce_float(p.get("score"), 0.0),
                                )
                                for p in exp_papers
                            ],
                        ),
                        subquestions=_subquestion_state(
                            subquestions, active_id=exp_sq.id,
                            completed_ids=completed_sq_ids, partial_ids=partial_sq_ids,
                        ),
                        budget=budget.get_state(),
                    ), sessions)

                    exp_keep = min(settings.max_papers_per_subquestion, len(exp_papers))
                    exp_retained = exp_papers[:exp_keep]
                    exp_pruned = exp_papers[exp_keep:]

                    await _post(on_update, WebhookUpdateRequest(
                        session_id=sid, status="running", active_stage="retrieving",
                        event=_evt("retrieval", f"Expansion {exp_sq.id}: pruned {len(exp_pruned)}, kept {exp_keep}."),
                        graph_patch=GraphPatch(nodes=[
                            GraphNode(
                                id=p["id"], label=_clip(str(p.get("title", p["id"]))), type="paper",
                                status="discarded", score=_coerce_float(p.get("score"), 0.0),
                                metadata={"title": p.get("title", ""), "branch": "pruned"},
                            )
                            for p in exp_pruned
                        ] + [
                            GraphNode(
                                id=p["id"], label=_clip(str(p.get("title", p["id"]))), type="paper",
                                status="active", score=_coerce_float(p.get("score"), 0.0),
                                metadata={"title": p.get("title", ""), "branch": "retained"},
                            )
                            for p in exp_retained
                        ]),
                        subquestions=_subquestion_state(
                            subquestions, active_id=exp_sq.id,
                            completed_ids=completed_sq_ids, partial_ids=partial_sq_ids,
                        ),
                        budget=budget.get_state(),
                    ), sessions)
                    budget.complete(exp_retrieve_key)

                    budget.activate(exp_extract_key)
                    budget.set_next_step_estimate("extract", exp_extract_key)
                    exp_seeds = _build_seed_findings(
                        exp_sq, exp_retained, limit=max(2, settings.max_papers_per_subquestion)
                    )

                    if exp_seeds:
                        await _post(on_update, WebhookUpdateRequest(
                            session_id=sid, status="running", active_stage="extracting",
                            event=_evt("extraction", f"Expansion {exp_sq.id}: drafted {len(exp_seeds)} candidate findings."),
                            graph_patch=GraphPatch(
                                nodes=[
                                    GraphNode(
                                        id=s["candidate_id"], label=_clip(s["claim"]), type="finding",
                                        status="active", score=_coerce_float(s.get("confidence"), 0.5),
                                        metadata={"phase": "candidate", "source_ids": s["source_ids"]},
                                    )
                                    for s in exp_seeds
                                ],
                                edges=[
                                    edge for s in exp_seeds
                                    for edge in _source_edges(
                                        s["candidate_id"], s["source_ids"],
                                        _coerce_float(s.get("confidence"), 0.5),
                                    )
                                ],
                            ),
                            subquestions=_subquestion_state(
                                subquestions, active_id=exp_sq.id,
                                completed_ids=completed_sq_ids, partial_ids=partial_sq_ids,
                            ),
                            budget=budget.get_state(),
                        ), sessions)

                    exp_extracted: list[dict[str, Any]] = []
                    if budget.available_for(exp_extract_key) >= max(estimate_step_cost("extract") * 0.30, 0.0015):
                        if TEST_MODE:
                            exp_extracted = _test_extract_findings(exp_sq, exp_retained, exp_seeds)
                            in_tok_e, out_tok_e = _synthetic_usage("extract")
                        else:
                            context_e = "\n\n".join(
                                f"[{p['id']}] {p['title']}\n" + "\n".join(p.get("chunks") or [])
                                for p in exp_retained
                            )
                            seed_text_e = "\n".join(
                                f"- [{s['candidate_id']}] {s['claim']}"
                                for s in exp_seeds
                            ) or "- No seed findings."
                            raw_ef, in_tok_e, out_tok_e = await _chat([
                                {
                                    "role": "system",
                                    "content": (
                                        "Extract up to 3 grounded findings. Return ONLY a JSON array: "
                                        "{\"claim\": str, \"source_ids\": [paper_id], \"confidence\": float, \"candidate_ids\": [seed_id]}."
                                    ),
                                },
                                {
                                    "role": "user",
                                    "content": (
                                        f"Subquestion: {exp_sq.text}\n\n"
                                        f"Candidate findings:\n{seed_text_e}\n\n"
                                        f"Paper context:\n{context_e}"
                                    ),
                                },
                            ], max_tokens=520)
                            exp_extracted = json.loads(_strip_json(raw_ef))
                            if not isinstance(exp_extracted, list):
                                exp_extracted = []
                        budget.record_spend(compute_openai_cost(GPT4O, in_tok_e, out_tok_e), exp_extract_key)

                    merged_e = _dedupe_findings([item for item in exp_extracted if isinstance(item, dict)])
                    if not merged_e:
                        merged_e = [_diagnostic_finding(exp_sq, exp_papers)]

                    selected_cids_e = {cid for f in merged_e for cid in (f.get("candidate_ids") or [])}
                    seed_status_e = [
                        GraphNode(
                            id=s["candidate_id"], label=_clip(s["claim"]), type="finding",
                            status="completed" if s["candidate_id"] in selected_cids_e else "discarded",
                            score=_coerce_float(s.get("confidence"), 0.5),
                            metadata={"phase": "candidate", "source_ids": s["source_ids"]},
                        )
                        for s in exp_seeds
                    ]

                    new_findings_e: list[FindingCard] = []
                    finding_nodes_e: list[GraphNode] = []
                    finding_edges_e: list[GraphEdge] = []
                    for idx, raw_fe in enumerate(merged_e[:3]):
                        src_ids = [
                            s for s in list(raw_fe.get("source_ids") or [])
                            if any(s == p["id"] for p in exp_retained + exp_pruned)
                        ]
                        if not src_ids and exp_retained:
                            src_ids = [exp_retained[min(idx, len(exp_retained) - 1)]["id"]]
                        claim = _claim_from_chunk(str(raw_fe.get("claim", "")))
                        if not claim:
                            continue
                        confidence = round(_coerce_float(raw_fe.get("confidence"), 0.62), 2)
                        finding = FindingCard(
                            id=f"f_{exp_sq.id}_{idx}",
                            subquestion_id=exp_sq.id,
                            claim=claim,
                            source_ids=src_ids,
                            confidence=confidence,
                            created_at=_now(),
                        )
                        memory.add_finding(finding)
                        new_findings_e.append(finding)
                        finding_nodes_e.append(GraphNode(
                            id=finding.id, label=_clip(finding.claim), type="finding", status="completed",
                            score=finding.confidence,
                            metadata={"source_ids": finding.source_ids, "phase": "retained"},
                        ))
                        finding_edges_e.extend(_source_edges(finding.id, finding.source_ids, finding.confidence))

                    if not new_findings_e:
                        diag_e = _diagnostic_finding(exp_sq, exp_papers)
                        finding = FindingCard(
                            id=f"f_{exp_sq.id}_0", subquestion_id=exp_sq.id,
                            claim=diag_e["claim"], source_ids=diag_e["source_ids"],
                            confidence=diag_e["confidence"], created_at=_now(),
                        )
                        memory.add_finding(finding)
                        new_findings_e.append(finding)
                        finding_nodes_e.append(GraphNode(
                            id=finding.id, label=_clip(finding.claim), type="finding", status="completed",
                            score=finding.confidence,
                            metadata={"source_ids": finding.source_ids, "phase": "retained"},
                        ))
                        finding_edges_e.extend(_source_edges(finding.id, finding.source_ids, finding.confidence))

                    completed_sq_ids.add(exp_sq.id)
                    budget.complete(exp_extract_key)

                    await _post(on_update, WebhookUpdateRequest(
                        session_id=sid, status="running", active_stage="extracting",
                        event=_evt("extraction", f"Expansion {exp_sq.id}: retained {len(new_findings_e)} findings."),
                        graph_patch=GraphPatch(
                            nodes=[
                                GraphNode(
                                    id=exp_sq.id, label=_clip(exp_sq.text), type="subquestion", status="completed",
                                    metadata={"subquestion": exp_sq.text, "expansion": True},
                                ),
                                *seed_status_e,
                                *finding_nodes_e,
                            ],
                            edges=finding_edges_e,
                        ),
                        subquestions=_subquestion_state(subquestions, completed_ids=completed_sq_ids, partial_ids=partial_sq_ids),
                        new_findings=new_findings_e,
                        budget=budget.get_state(),
                    ), sessions)

        # ── Stage 3: Synthesize ───────────────────────────────────────────────
        retained = memory.get_findings()
        budget.activate("synthesize")
        budget.set_next_step_estimate("synthesize", "synthesize")

        final: FinalAnswer
        if not retained:
            final = FinalAnswer(
                text="The run completed without retaining any grounded findings to synthesize.",
                citations=[],
                uncertainty="high",
            )
            status = "partial"
        else:
            if budget.available_for("synthesize") >= max(estimate_step_cost("synthesize") * 0.20, 0.001):
                findings_text = "\n".join(
                    f"- [{finding.id}] ({finding.confidence:.2f}) {finding.claim}"
                    for finding in retained
                )
                if TEST_MODE:
                    final = _test_synthesize(snapshot.query, retained)
                    in_tok, out_tok = _synthetic_usage("synthesize")
                else:
                    raw_s, in_tok, out_tok = await _chat([
                        {
                            "role": "system",
                            "content": (
                                "Synthesize a concise research answer grounded only in the retained findings. "
                                "Return JSON: {\"text\": str, \"citations\": [finding_id], \"uncertainty\": \"low\"|\"medium\"|\"high\"}."
                            ),
                        },
                        {
                            "role": "user",
                            "content": f"Query: {snapshot.query}\n\nRetained findings:\n{findings_text}",
                        },
                    ], max_tokens=650)
                    synth = json.loads(_strip_json(raw_s))
                    if not isinstance(synth, dict):
                        raise RuntimeError("Synthesis response was not a JSON object.")
                    final = FinalAnswer(
                        text=synth.get("text", raw_s),
                        citations=synth.get("citations", [finding.id for finding in retained[:4]]),
                        uncertainty=synth.get("uncertainty", "medium"),
                    )
                budget.record_spend(compute_openai_cost(GPT4O, in_tok, out_tok), "synthesize")
            else:
                raise RuntimeError("Budget exhausted before synthesis could run.")

            strong_signal = any(finding.confidence >= 0.55 for finding in retained)
            status = "completed" if strong_signal else "partial"

        budget.complete("synthesize")
        final_node = GraphNode(
            id="final_0",
            label="Final Answer",
            type="final",
            status="completed",
            metadata={"citations": final.citations, "uncertainty": final.uncertainty},
        )
        cited_ids = set(final.citations or [finding.id for finding in retained[:5]])
        final_edges = [
            GraphEdge(
                id=f"e_{finding.id}_final",
                source=finding.id,
                target="final_0",
                type="supports",
                weight=finding.confidence,
            )
            for finding in retained
            if finding.id in cited_ids
        ]

        await _post(on_update, WebhookUpdateRequest(
            session_id=sid,
            status=status,
            active_stage="completed",
            event=_evt("synthesis", "Research complete. Final answer synthesized from retained branches."),
            graph_patch=GraphPatch(nodes=[final_node], edges=final_edges),
            subquestions=_subquestion_state(subquestions, completed_ids=completed_sq_ids, partial_ids=partial_sq_ids),
            final_answer=final,
            budget=budget.get_state(),
        ), sessions)
    except Exception as exc:
        await _post(on_update, WebhookUpdateRequest(
            session_id=sid,
            status="failed",
            active_stage="failed",
            event=_evt("error", f"Pipeline failed: {exc}"),
            subquestions=_subquestion_state(subquestions, completed_ids=completed_sq_ids, partial_ids=partial_sq_ids),
            budget=budget.get_state(),
            final_answer=FinalAnswer(
                text="The research pipeline failed before it could finish synthesizing an answer.",
                citations=[],
                uncertainty="high",
            ),
        ), sessions)
