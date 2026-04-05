"""Purpose: Handle local category scoring, paper ranking, chunk selection, and embedding-based retrieval."""

from __future__ import annotations

import math
import os
from typing import Any

import httpx

OPENAI_API_KEY = os.environ.get("OPEN_AI_API_KEY", "")
EMBEDDING_MODEL = "text-embedding-3-small"

# ── Embedded corpus ────────────────────────────────────────────────────────────
# Small set of paper summaries that covers common research topics.
# Add more entries here to expand local retrieval coverage.
CORPUS: list[dict[str, Any]] = [
    {
        "id": "paper_001",
        "title": "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
        "categories": ["retrieval", "generation", "knowledge"],
        "abstract": (
            "We explore retrieval-augmented generation (RAG) models, which combine parametric "
            "memory with non-parametric memory for language generation. RAG models retrieve "
            "documents with a dense passage retriever and attend over retrieved documents in "
            "generation, achieving state-of-the-art results on knowledge-intensive NLP tasks."
        ),
        "chunks": [
            "RAG combines parametric and non-parametric memory for open-domain question answering.",
            "Dense passage retrieval is used to fetch relevant documents before generation.",
            "The generator conditions on retrieved documents to produce more grounded outputs.",
        ],
    },
    {
        "id": "paper_002",
        "title": "Limitations of Retrieval-Augmented Generation Systems",
        "categories": ["retrieval", "limitations", "robustness"],
        "abstract": (
            "We analyze key limitations of RAG systems including retrieval noise, context window "
            "constraints, hallucination from irrelevant context, and latency trade-offs. Our "
            "study shows noisy retrieved passages can degrade generation quality significantly."
        ),
        "chunks": [
            "Retrieved noise is a major challenge: irrelevant passages cause hallucination.",
            "Context window limitations prevent incorporating many retrieved documents.",
            "Latency is significantly higher in RAG compared to pure parametric models.",
            "Retrieval quality bottlenecks overall system performance on knowledge-intensive tasks.",
        ],
    },
    {
        "id": "paper_003",
        "title": "Chain-of-Thought Prompting for Complex Reasoning",
        "categories": ["reasoning", "prompting", "generation"],
        "abstract": (
            "Chain-of-thought prompting enables large language models to perform complex reasoning "
            "by generating intermediate steps. We show this substantially improves performance "
            "on arithmetic, commonsense, and symbolic reasoning benchmarks."
        ),
        "chunks": [
            "Chain-of-thought prompting improves multi-step arithmetic reasoning.",
            "Intermediate reasoning steps help models avoid shortcut solutions.",
            "Larger models benefit more from chain-of-thought than smaller ones.",
        ],
    },
    {
        "id": "paper_004",
        "title": "Dense Passage Retrieval for Open-Domain Question Answering",
        "categories": ["retrieval", "question answering", "dense vectors"],
        "abstract": (
            "We present DPR, a dense passage retrieval approach using bi-encoder BERT models. "
            "DPR outperforms BM25 on multiple QA benchmarks and enables efficient large-scale "
            "retrieval with FAISS approximate nearest neighbor search."
        ),
        "chunks": [
            "Bi-encoder models encode queries and passages independently for efficient retrieval.",
            "DPR outperforms BM25 on NaturalQuestions, TriviaQA, and WebQuestions.",
            "FAISS enables sub-second retrieval over millions of passages.",
        ],
    },
    {
        "id": "paper_005",
        "title": "Hallucination in Large Language Models: Survey and Mitigation",
        "categories": ["hallucination", "generation", "robustness"],
        "abstract": (
            "We survey hallucination phenomena in LLMs, categorizing intrinsic and extrinsic "
            "hallucinations. Mitigation strategies include retrieval augmentation, constrained "
            "decoding, and factuality-aware fine-tuning."
        ),
        "chunks": [
            "Intrinsic hallucinations contradict the source document.",
            "Extrinsic hallucinations introduce unverifiable information not in the source.",
            "Retrieval augmentation significantly reduces factual hallucination rates.",
            "Constrained decoding can prevent certain categories of hallucinated outputs.",
        ],
    },
    {
        "id": "paper_006",
        "title": "REALM: Retrieval-Enhanced Language Model Pre-Training",
        "categories": ["retrieval", "pre-training", "knowledge"],
        "abstract": (
            "REALM augments language model pre-training with a learned knowledge retriever. "
            "The retriever and language model are jointly trained, allowing the model to retrieve "
            "relevant documents from a large corpus during pre-training and fine-tuning."
        ),
        "chunks": [
            "REALM jointly trains the retriever and language model end-to-end.",
            "The retriever is trained to fetch passages that improve masked language modeling.",
            "REALM achieves strong results on open-domain QA with explicit knowledge retrieval.",
        ],
    },
    {
        "id": "paper_007",
        "title": "Budget-Constrained Inference with Adaptive Computation",
        "categories": ["efficiency", "budget", "adaptive"],
        "abstract": (
            "We present adaptive computation strategies for inference under cost constraints. "
            "Methods include early exit, dynamic depth selection, and retrieval throttling. "
            "Our approach maintains accuracy while reducing computational expenditure by 40%."
        ),
        "chunks": [
            "Early exit strategies allow models to skip expensive late layers when confident.",
            "Dynamic retrieval throttling reduces costs when the model is already confident.",
            "Budget-aware inference can produce partial answers when the cost cap is reached.",
        ],
    },
    {
        "id": "paper_008",
        "title": "Knowledge Graphs for Enhanced Retrieval-Augmented Systems",
        "categories": ["knowledge", "graph", "retrieval"],
        "abstract": (
            "Integrating structured knowledge graphs with retrieval-augmented generation improves "
            "multi-hop reasoning. The graph provides explicit entity-relation links that guide "
            "retrieval and reduce hallucination on complex questions."
        ),
        "chunks": [
            "Knowledge graphs provide structured entity-relation information for retrieval.",
            "Graph-enhanced RAG improves multi-hop question answering over plain dense retrieval.",
            "Explicit graph structure reduces hallucination on questions requiring entity chaining.",
        ],
    },
]


# ── Embedding helpers ──────────────────────────────────────────────────────────

async def get_embeddings(texts: list[str]) -> list[list[float]]:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://api.openai.com/v1/embeddings",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            json={"model": EMBEDDING_MODEL, "input": texts},
            timeout=30.0,
        )
        resp.raise_for_status()
    return [item["embedding"] for item in resp.json()["data"]]


def _dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _norm(v: list[float]) -> float:
    return math.sqrt(sum(x * x for x in v))


def cosine_similarity(a: list[float], b: list[float]) -> float:
    denom = _norm(a) * _norm(b)
    return _dot(a, b) / denom if denom > 0 else 0.0


# ── Public retrieval API ───────────────────────────────────────────────────────

async def retrieve_top_papers(
    subquestion: str,
    max_papers: int,
    max_chunks: int,
) -> list[dict[str, Any]]:
    """Embed the subquestion, rank corpus papers by similarity, return top papers with chunks."""
    texts = [subquestion] + [p["abstract"] for p in CORPUS]
    embeddings = await get_embeddings(texts)
    query_emb = embeddings[0]
    paper_embs = embeddings[1:]

    scored = sorted(
        zip(paper_embs, CORPUS),
        key=lambda x: cosine_similarity(query_emb, x[0]),
        reverse=True,
    )

    results: list[dict[str, Any]] = []
    for emb, paper in scored[:max_papers]:
        score = cosine_similarity(query_emb, emb)
        # Rank chunks by similarity to the subquestion
        if paper["chunks"]:
            chunk_embs = await get_embeddings(paper["chunks"])
            ranked_chunks = sorted(
                zip(chunk_embs, paper["chunks"]),
                key=lambda x: cosine_similarity(query_emb, x[0]),
                reverse=True,
            )
            top_chunks = [ch for _, ch in ranked_chunks[:max_chunks]]
        else:
            top_chunks = []

        results.append({
            "id": paper["id"],
            "title": paper["title"],
            "score": round(score, 4),
            "chunks": top_chunks,
        })
    return results
