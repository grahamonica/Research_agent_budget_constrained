"use strict";

const { randomUUID } = require("crypto");

const OPENAI_API_KEY = process.env.OPEN_AI_API_KEY || "";
const GPT4O = "gpt-4o";
const EMBEDDING_MODEL = "text-embedding-3-small";
const TEST_MODE = ["1", "true", "yes"].includes(
  String(process.env.RESEARCH_AGENT_TEST_MODE || "").toLowerCase(),
);

const CORPUS = [
  {
    id: "paper_001",
    title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
    categories: ["retrieval", "generation", "knowledge"],
    abstract:
      "We explore retrieval-augmented generation (RAG) models, which combine parametric memory with non-parametric memory for language generation. RAG models retrieve documents with a dense passage retriever and attend over retrieved documents in generation, achieving state-of-the-art results on knowledge-intensive NLP tasks.",
    chunks: [
      "RAG combines parametric and non-parametric memory for open-domain question answering.",
      "Dense passage retrieval is used to fetch relevant documents before generation.",
      "The generator conditions on retrieved documents to produce more grounded outputs.",
    ],
  },
  {
    id: "paper_002",
    title: "Limitations of Retrieval-Augmented Generation Systems",
    categories: ["retrieval", "limitations", "robustness"],
    abstract:
      "We analyze key limitations of RAG systems including retrieval noise, context window constraints, hallucination from irrelevant context, and latency trade-offs. Our study shows noisy retrieved passages can degrade generation quality significantly.",
    chunks: [
      "Retrieved noise is a major challenge: irrelevant passages cause hallucination.",
      "Context window limitations prevent incorporating many retrieved documents.",
      "Latency is significantly higher in RAG compared to pure parametric models.",
      "Retrieval quality bottlenecks overall system performance on knowledge-intensive tasks.",
    ],
  },
  {
    id: "paper_003",
    title: "Chain-of-Thought Prompting for Complex Reasoning",
    categories: ["reasoning", "prompting", "generation"],
    abstract:
      "Chain-of-thought prompting enables large language models to perform complex reasoning by generating intermediate steps. We show this substantially improves performance on arithmetic, commonsense, and symbolic reasoning benchmarks.",
    chunks: [
      "Chain-of-thought prompting improves multi-step arithmetic reasoning.",
      "Intermediate reasoning steps help models avoid shortcut solutions.",
      "Larger models benefit more from chain-of-thought than smaller ones.",
    ],
  },
  {
    id: "paper_004",
    title: "Dense Passage Retrieval for Open-Domain Question Answering",
    categories: ["retrieval", "question answering", "dense vectors"],
    abstract:
      "We present DPR, a dense passage retrieval approach using bi-encoder BERT models. DPR outperforms BM25 on multiple QA benchmarks and enables efficient large-scale retrieval with FAISS approximate nearest neighbor search.",
    chunks: [
      "Bi-encoder models encode queries and passages independently for efficient retrieval.",
      "DPR outperforms BM25 on NaturalQuestions, TriviaQA, and WebQuestions.",
      "FAISS enables sub-second retrieval over millions of passages.",
    ],
  },
  {
    id: "paper_005",
    title: "Hallucination in Large Language Models: Survey and Mitigation",
    categories: ["hallucination", "generation", "robustness"],
    abstract:
      "We survey hallucination phenomena in LLMs, categorizing intrinsic and extrinsic hallucinations. Mitigation strategies include retrieval augmentation, constrained decoding, and factuality-aware fine-tuning.",
    chunks: [
      "Intrinsic hallucinations contradict the source document.",
      "Extrinsic hallucinations introduce unverifiable information not in the source.",
      "Retrieval augmentation significantly reduces factual hallucination rates.",
      "Constrained decoding can prevent certain categories of hallucinated outputs.",
    ],
  },
  {
    id: "paper_006",
    title: "REALM: Retrieval-Enhanced Language Model Pre-Training",
    categories: ["retrieval", "pre-training", "knowledge"],
    abstract:
      "REALM augments language model pre-training with a learned knowledge retriever. The retriever and language model are jointly trained, allowing the model to retrieve relevant documents from a large corpus during pre-training and fine-tuning.",
    chunks: [
      "REALM jointly trains the retriever and language model end-to-end.",
      "The retriever is trained to fetch passages that improve masked language modeling.",
      "REALM achieves strong results on open-domain QA with explicit knowledge retrieval.",
    ],
  },
  {
    id: "paper_007",
    title: "Budget-Constrained Inference with Adaptive Computation",
    categories: ["efficiency", "budget", "adaptive"],
    abstract:
      "We present adaptive computation strategies for inference under cost constraints. Methods include early exit, dynamic depth selection, and retrieval throttling. Our approach maintains accuracy while reducing computational expenditure by 40%.",
    chunks: [
      "Early exit strategies allow models to skip expensive late layers when confident.",
      "Dynamic retrieval throttling reduces costs when the model is already confident.",
      "Budget-aware inference can produce partial answers when the cost cap is reached.",
    ],
  },
  {
    id: "paper_008",
    title: "Knowledge Graphs for Enhanced Retrieval-Augmented Systems",
    categories: ["knowledge", "graph", "retrieval"],
    abstract:
      "Integrating structured knowledge graphs with retrieval-augmented generation improves multi-hop reasoning. The graph provides explicit entity-relation links that guide retrieval and reduce hallucination on complex questions.",
    chunks: [
      "Knowledge graphs provide structured entity-relation information for retrieval.",
      "Graph-enhanced RAG improves multi-hop question answering over plain dense retrieval.",
      "Explicit graph structure reduces hallucination on questions requiring entity chaining.",
    ],
  },
];

const PRICING = {
  "text-embedding-3-small": { input: 0.02 / 1_000_000 },
  "gpt-4o": { input: 2.5 / 1_000_000, output: 10 / 1_000_000 },
};

const STEP_ESTIMATES = {
  decompose: { model: "gpt-4o", input: 400, output: 250 },
  retrieve: { model: "text-embedding-3-small", input: 1200 },
  extract: { model: "gpt-4o", input: 1400, output: 450 },
  synthesize: { model: "gpt-4o", input: 1500, output: 550 },
};

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function now() {
  return new Date().toISOString();
}

function stripJson(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?(.*?)\n?```$/s);
  return match ? match[1].trim() : trimmed;
}

function clip(text, limit = 60) {
  return String(text || "").trim().slice(0, limit);
}

function evt(stage, message) {
  return {
    id: `evt_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
    stage,
    message,
    created_at: now(),
  };
}

function claimFromChunk(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const parts = cleaned.split(/(?<=[.!?])\s+/);
  const sentence = (parts[0] || cleaned).trim().replace(/\.$/, "");
  return sentence ? `${sentence}.` : "";
}

function sourceEdges(targetId, sourceIds, confidence) {
  return sourceIds.map((sourceId) => ({
    id: `e_${sourceId}_${targetId}`,
    source: sourceId,
    target: targetId,
    type: "supports",
    weight: confidence,
  }));
}

function coerceFloat(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dedupeFindings(items) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const claim = String(item?.claim || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!claim || seen.has(claim)) {
      continue;
    }
    seen.add(claim);
    deduped.push(item);
  }
  return deduped;
}

function buildSeedFindings(subquestion, papers, limit) {
  const seeds = [];
  for (const [index, paper] of papers.slice(0, limit).entries()) {
    const chunks = paper.chunks || [];
    if (!chunks.length) {
      continue;
    }
    const claim = claimFromChunk(String(chunks[0]));
    if (!claim) {
      continue;
    }
    seeds.push({
      candidate_id: `seed_${subquestion.id}_${index}`,
      claim,
      source_ids: [paper.id],
      confidence: round(Math.max(0.42, Math.min(0.88, 0.38 + coerceFloat(paper.score, 0) * 0.62)), 2),
    });
  }
  return seeds;
}

function diagnosticFinding(subquestion, papers) {
  if (!papers.length) {
    return {
      claim: "No candidate papers were retrieved for this subquestion in the local corpus.",
      source_ids: [],
      confidence: 0.25,
    };
  }
  const topScore = coerceFloat(papers[0]?.score, 0);
  if (topScore < 0.22) {
    return {
      claim: "The local paper corpus did not contain strong direct matches for this subquestion.",
      source_ids: papers.slice(0, 2).map((paper) => paper.id),
      confidence: 0.32,
    };
  }
  return {
    claim: `Evidence for this subquestion was thin and concentrated in ${clip(String(papers[0]?.title || "one paper"), 48)}.`,
    source_ids: papers.slice(0, 2).map((paper) => paper.id),
    confidence: 0.4,
  };
}

function syntheticUsage(step) {
  if (step === "decompose") {
    return [420, 220];
  }
  if (step === "extract") {
    return [950, 260];
  }
  if (step === "synthesize") {
    return [1200, 320];
  }
  return [0, 0];
}

function testDecomposeQuery(query, maxSubquestions) {
  const topic = String(query || "").trim().replace(/[?.!]+$/, "");
  const lowered = topic ? `${topic.slice(0, 1).toLowerCase()}${topic.slice(1)}` : "the research question";
  return [
    `What mechanisms or drivers explain ${lowered}?`,
    `Which papers provide the strongest direct evidence about ${lowered}?`,
    `What trade-offs, uncertainties, or failure modes shape ${lowered}?`,
  ].slice(0, maxSubquestions);
}

function candidateIdsForSources(seedFindings, sourceIds) {
  return seedFindings
    .filter((seed) => seed.source_ids.some((sourceId) => sourceIds.includes(sourceId)))
    .map((seed) => seed.candidate_id);
}

function testExtractFindings(subquestion, papers, seedFindings) {
  const extracted = [];
  for (const paper of papers.slice(0, 3)) {
    const chunks = paper.chunks || [];
    if (!chunks.length) {
      continue;
    }
    extracted.push({
      claim: claimFromChunk(String(chunks[0])),
      source_ids: [paper.id],
      confidence: round(Math.max(0.55, Math.min(0.91, coerceFloat(paper.score, 0) + 0.18)), 2),
      candidate_ids: candidateIdsForSources(seedFindings, [paper.id]),
    });
  }
  if (!extracted.length) {
    extracted.push(diagnosticFinding(subquestion, papers));
  }
  return extracted.slice(0, 3);
}

function testSynthesize(query, findings) {
  const ranked = [...findings].sort((left, right) => right.confidence - left.confidence);
  const citations = ranked.slice(0, 3).map((finding) => finding.id);
  if (!ranked.length) {
    return {
      text: "The run completed without retaining enough evidence to synthesize a grounded answer.",
      citations: [],
      uncertainty: "high",
    };
  }
  const topClaims = ranked.slice(0, 3).map((finding) => finding.claim);
  const confidence =
    ranked.slice(0, 3).reduce((sum, finding) => sum + finding.confidence, 0) /
    Math.min(ranked.length, 3);
  const uncertainty = confidence >= 0.8 ? "low" : confidence >= 0.6 ? "medium" : "high";
  return {
    text: `${String(query || "").replace(/[?.!]+$/, "")}: ${topClaims.join(" ")}`,
    citations,
    uncertainty,
  };
}

function computeOpenAICost(model, inputTokens, outputTokens = 0) {
  const pricing = PRICING[model] || {};
  return round((inputTokens || 0) * (pricing.input || 0) + (outputTokens || 0) * (pricing.output || 0), 8);
}

function estimateStepCost(step) {
  const estimate = STEP_ESTIMATES[step];
  if (!estimate) {
    return 0;
  }
  const pricing = PRICING[estimate.model];
  let cost = estimate.input * pricing.input;
  if (typeof estimate.output === "number") {
    cost += estimate.output * (pricing.output || 0);
  }
  return round(cost, 8);
}

class BudgetTracker {
  constructor(capUsd) {
    this.capUsd = Number(capUsd);
    this.spentUsd = 0;
    this.nextEstimate = 0;
    this.activeKey = null;
    this.allocations = {};
    this.order = [];
    this.ensureBasePlan();
  }

  static fromState(rawBudget) {
    const tracker = new BudgetTracker(rawBudget?.cap_usd ?? 0.05);
    tracker.spentUsd = round(rawBudget?.spent_usd ?? 0, 8);
    tracker.nextEstimate = round(rawBudget?.estimated_next_step_usd ?? 0, 8);
    tracker.activeKey = rawBudget?.active_allocation_key ?? null;
    tracker.allocations = {};
    tracker.order = [];

    const allocations = Array.isArray(rawBudget?.allocations) ? rawBudget.allocations : [];
    if (!allocations.length) {
      tracker.ensureBasePlan();
      return tracker;
    }

    for (const allocation of allocations) {
      tracker.allocations[allocation.key] = {
        key: allocation.key,
        label: allocation.label,
        allocated_usd: round(allocation.allocated_usd ?? 0, 6),
        spent_usd: round(allocation.spent_usd ?? 0, 6),
        remaining_usd: round(allocation.remaining_usd ?? 0, 6),
        status: allocation.status ?? "planned",
      };
      tracker.order.push(allocation.key);
    }
    return tracker;
  }

  ensureBasePlan() {
    if (this.allocations.decompose) {
      return;
    }
    this.upsertAllocation("decompose", "Decompose query", round(this.capUsd * 0.1, 6));
  }

  upsertAllocation(key, label, allocatedUsd) {
    const allocated = round(Math.max(0, allocatedUsd), 6);
    const existing = this.allocations[key];
    if (!existing) {
      this.allocations[key] = {
        key,
        label,
        allocated_usd: allocated,
        spent_usd: 0,
        remaining_usd: allocated,
        status: "planned",
      };
      this.order.push(key);
      return;
    }
    existing.label = label;
    existing.allocated_usd = allocated;
    existing.remaining_usd = round(Math.max(0, allocated - existing.spent_usd), 6);
    if (existing.status === "depleted" && existing.remaining_usd > 0) {
      existing.status = "planned";
    }
  }

  planResearch(subquestionIds) {
    const sqCount = Math.max(1, subquestionIds.length);
    const synthesisBudget = round(this.capUsd * 0.2, 6);
    const decomposeBudget = this.allocations.decompose.allocated_usd;
    const workBudget = round(Math.max(0, this.capUsd - decomposeBudget - synthesisBudget), 6);
    const perSq = sqCount ? workBudget / sqCount : 0;

    this.upsertAllocation("synthesize", "Synthesize final answer", synthesisBudget);
    for (const subquestionId of subquestionIds) {
      this.upsertAllocation(
        `retrieve:${subquestionId}`,
        `Retrieve papers for ${subquestionId}`,
        round(perSq * 0.42, 6),
      );
      this.upsertAllocation(
        `extract:${subquestionId}`,
        `Extract findings for ${subquestionId}`,
        round(perSq * 0.58, 6),
      );
    }
  }

  activate(key) {
    if (!this.allocations[key]) {
      return;
    }
    if (this.activeKey && this.allocations[this.activeKey]?.status === "active") {
      this.allocations[this.activeKey].status = "planned";
    }
    this.activeKey = key;
    const allocation = this.allocations[key];
    if (!["completed", "skipped", "depleted"].includes(allocation.status)) {
      allocation.status = "active";
    }
  }

  complete(key) {
    const allocation = this.allocations[key];
    if (!allocation) {
      return;
    }
    allocation.status = allocation.remaining_usd <= 0 ? "depleted" : "completed";
    if (this.activeKey === key) {
      this.activeKey = null;
    }
  }

  recordSpend(amount, allocationKey = null) {
    const spend = round(Math.max(0, amount), 8);
    this.spentUsd = round(this.spentUsd + spend, 8);
    const key = allocationKey || this.activeKey;
    if (!key || !this.allocations[key]) {
      return;
    }
    const allocation = this.allocations[key];
    allocation.spent_usd = round(allocation.spent_usd + spend, 6);
    allocation.remaining_usd = round(Math.max(0, allocation.allocated_usd - allocation.spent_usd), 6);
    if (allocation.remaining_usd <= 0 && !["completed", "skipped"].includes(allocation.status)) {
      allocation.status = "depleted";
    }
  }

  setNextStepEstimate(step, allocationKey = null) {
    let estimate = estimateStepCost(step);
    if (allocationKey && this.allocations[allocationKey]) {
      estimate = Math.min(estimate, this.availableFor(allocationKey));
    }
    this.nextEstimate = round(Math.max(0, estimate), 8);
  }

  availableFor(key) {
    if (!this.allocations[key]) {
      return 0;
    }
    const totalRemaining = Math.max(0, this.capUsd - this.spentUsd);
    let reservedForOthers = 0;
    for (const [otherKey, allocation] of Object.entries(this.allocations)) {
      if (otherKey === key) {
        continue;
      }
      if (["planned", "active"].includes(allocation.status)) {
        reservedForOthers += allocation.remaining_usd;
      }
    }
    return round(Math.max(0, totalRemaining - reservedForOthers), 6);
  }

  isOverLimit() {
    return this.spentUsd >= this.capUsd;
  }

  getState() {
    return {
      cap_usd: this.capUsd,
      spent_usd: round(this.spentUsd, 6),
      remaining_usd: round(Math.max(0, this.capUsd - this.spentUsd), 6),
      estimated_next_step_usd: round(this.nextEstimate, 6),
      active_allocation_key: this.activeKey,
      allocations: this.order.map((key) => ({ ...this.allocations[key] })),
    };
  }
}

function terms(text) {
  return new Set(String(text || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function lexicalOverlap(query, text) {
  const queryTerms = terms(query);
  const textTerms = terms(text);
  if (!queryTerms.size || !textTerms.size) {
    return 0;
  }
  let overlap = 0;
  for (const term of queryTerms) {
    if (textTerms.has(term)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(queryTerms.size, 1);
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function norm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function cosineSimilarity(left, right) {
  const denom = norm(left) * norm(right);
  return denom > 0 ? dot(left, right) / denom : 0;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 400)}`);
  }
  return response.json();
}

async function getEmbeddings(texts) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPEN_AI_API_KEY is required for embedding retrieval.");
  }
  const data = await fetchJson("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
    }),
  });
  return data.data.map((item) => item.embedding);
}

async function retrieveTopPapers(subquestion, maxPapers, maxChunks) {
  if (TEST_MODE) {
    const scoredLocal = [...CORPUS]
      .map((paper) => [
        round(
          lexicalOverlap(subquestion, `${paper.title} ${paper.abstract}`) * 0.65 +
            lexicalOverlap(subquestion, paper.chunks.join(" ")) * 0.35,
          4,
        ),
        paper,
      ])
      .sort((left, right) => right[0] - left[0]);

    return scoredLocal.slice(0, maxPapers).map(([score, paper], index) => {
      const rankedChunks = [...paper.chunks].sort(
        (left, right) => lexicalOverlap(subquestion, right) - lexicalOverlap(subquestion, left),
      );
      const topChunks = rankedChunks.slice(0, maxChunks);
      return {
        id: paper.id,
        title: paper.title,
        score,
        rank: index + 1,
        lexical_score: round(lexicalOverlap(subquestion, `${paper.title} ${paper.abstract}`), 4),
        chunks: topChunks,
        chunk_scores: topChunks.map((chunk) => round(lexicalOverlap(subquestion, chunk), 4)),
      };
    });
  }

  const embeddings = await getEmbeddings([subquestion, ...CORPUS.map((paper) => paper.abstract)]);
  const queryEmbedding = embeddings[0];
  const scored = CORPUS.map((paper, index) => {
    const abstractScore = cosineSimilarity(queryEmbedding, embeddings[index + 1]);
    const lexicalScore = lexicalOverlap(subquestion, `${paper.title} ${paper.abstract}`);
    const hybridScore = round(abstractScore * 0.72 + lexicalScore * 0.28, 4);
    return [hybridScore, paper];
  }).sort((left, right) => right[0] - left[0]);

  const results = [];
  for (const [index, [score, paper]] of scored.slice(0, maxPapers).entries()) {
    let topChunks = [];
    let chunkScores = [];
    if (paper.chunks.length) {
      const chunkEmbeddings = await getEmbeddings(paper.chunks);
      const rankedChunks = paper.chunks
        .map((chunk, chunkIndex) => [
          cosineSimilarity(queryEmbedding, chunkEmbeddings[chunkIndex]) * 0.78 +
            lexicalOverlap(subquestion, chunk) * 0.22,
          chunkEmbeddings[chunkIndex],
          chunk,
        ])
        .sort((left, right) => right[0] - left[0]);
      const topPairs = rankedChunks.slice(0, maxChunks);
      topChunks = topPairs.map((pair) => pair[2]);
      chunkScores = topPairs.map((pair) => round(cosineSimilarity(queryEmbedding, pair[1]), 4));
    }

    results.push({
      id: paper.id,
      title: paper.title,
      score,
      rank: index + 1,
      lexical_score: round(lexicalOverlap(subquestion, `${paper.title} ${paper.abstract}`), 4),
      chunks: topChunks,
      chunk_scores: chunkScores,
    });
  }
  return results;
}

async function chat(messages, maxTokens = 512) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPEN_AI_API_KEY is required for live research runs.");
  }
  const data = await fetchJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GPT4O,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });
  const usage = data.usage || {};
  return [data.choices[0]?.message?.content || "", usage.prompt_tokens || 0, usage.completion_tokens || 0];
}

async function postUpdate(state, payload) {
  const url = String(state.fastapi_webhook_url || "").trim();
  if (!url) {
    throw new Error("fastapi_webhook_url is required for workflow updates.");
  }

  const body = {
    session_id: state.session_id,
    ...payload,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to POST session update: ${response.status} ${response.statusText}: ${text.slice(0, 400)}`);
  }
}

function mainSubquestions(state) {
  return (state.subquestions || []).filter((subquestion) => !subquestion.expansion);
}

function expansionSubquestions(state) {
  return (state.subquestions || []).filter((subquestion) => subquestion.expansion);
}

function getCompletedSet(state) {
  return new Set(state.runtime?.completed_sq_ids || []);
}

function getPartialSet(state) {
  return new Set(state.runtime?.partial_sq_ids || []);
}

function writeSets(state, completed, partial) {
  state.runtime = state.runtime || {};
  state.runtime.completed_sq_ids = [...completed];
  state.runtime.partial_sq_ids = [...partial];
}

function subquestionState(state, { activeId = null } = {}) {
  const completed = getCompletedSet(state);
  const partial = getPartialSet(state);
  return (state.subquestions || []).map((subquestion) => {
    let status = "pending";
    if (subquestion.id === activeId) {
      status = "running";
    } else if (completed.has(subquestion.id)) {
      status = "completed";
    } else if (partial.has(subquestion.id)) {
      status = "partial";
    }
    return { id: subquestion.id, text: subquestion.text, status };
  });
}

function getFindings(state) {
  return Array.isArray(state.findings) ? state.findings : [];
}

function addFinding(state, finding) {
  state.findings = getFindings(state);
  state.findings.push(finding);
  if (state.findings.length > 20) {
    state.findings = state.findings.slice(state.findings.length - 20);
  }
}

function branchFor(state, subquestion) {
  state.runtime = state.runtime || {};
  state.runtime.branches = state.runtime.branches || {};
  if (!state.runtime.branches[subquestion.id]) {
    state.runtime.branches[subquestion.id] = {
      candidate_papers: [],
      retained_papers: [],
      pruned_papers: [],
      seed_findings: [],
      retrieve_budget: 0,
    };
  }
  return state.runtime.branches[subquestion.id];
}

function queryNode(state) {
  return {
    id: "q_0",
    label: clip(state.query),
    type: "query",
    status: "completed",
    metadata: { query: state.query },
  };
}

async function stageDecompose(state) {
  const budget = BudgetTracker.fromState(state.budget);
  budget.activate("decompose");
  budget.setNextStepEstimate("decompose", "decompose");
  state.status = "running";
  state.active_stage = "decomposing";
  state.budget = budget.getState();

  await postUpdate(state, {
    status: "running",
    active_stage: "decomposing",
    event: evt("planning", "Decomposing query into subquestions."),
    budget: state.budget,
  });

  let subquestionTexts = [];
  let inputTokens = 0;
  let outputTokens = 0;

  if (TEST_MODE) {
    subquestionTexts = testDecomposeQuery(state.query, state.settings.max_subquestions);
    [inputTokens, outputTokens] = syntheticUsage("decompose");
  } else {
    const [raw, inTok, outTok] = await chat(
      [
        {
          role: "system",
          content: `Break the research question into ${state.settings.max_subquestions} focused subquestions. Return ONLY a JSON array of strings.`,
        },
        { role: "user", content: state.query },
      ],
      320,
    );
    const parsed = JSON.parse(stripJson(raw));
    if (!Array.isArray(parsed)) {
      throw new Error("Decomposition response was not a JSON array.");
    }
    subquestionTexts = parsed;
    inputTokens = inTok;
    outputTokens = outTok;
  }

  budget.recordSpend(computeOpenAICost(GPT4O, inputTokens, outputTokens), "decompose");

  const cleanedSubquestions = subquestionTexts
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, state.settings.max_subquestions);
  if (!cleanedSubquestions.length) {
    throw new Error("Decomposition produced no subquestions.");
  }

  state.subquestions = cleanedSubquestions.map((text, index) => ({
    id: `sq_${index}`,
    text,
    expansion: false,
  }));

  budget.complete("decompose");
  budget.planResearch(state.subquestions.map((subquestion) => subquestion.id));
  state.active_stage = "planning";
  state.budget = budget.getState();

  await postUpdate(state, {
    status: "running",
    active_stage: "planning",
    event: evt("planning", `Allocated explicit sub-budgets across ${state.subquestions.length} subquestions.`),
    graph_patch: {
      nodes: [
        queryNode(state),
        ...state.subquestions.map((subquestion) => ({
          id: subquestion.id,
          label: clip(subquestion.text),
          type: "subquestion",
          status: "idle",
          metadata: { subquestion: subquestion.text },
        })),
      ],
      edges: state.subquestions.map((subquestion) => ({
        id: `e_q_${subquestion.id}`,
        source: "q_0",
        target: subquestion.id,
        type: "decomposes_to",
      })),
    },
    subquestions: subquestionState(state),
    budget: state.budget,
  });

  return state;
}

async function stageRetrieve(state, { expansion }) {
  const budget = BudgetTracker.fromState(state.budget);
  const completed = getCompletedSet(state);
  const partial = getPartialSet(state);
  const targets = expansion ? expansionSubquestions(state) : mainSubquestions(state);
  const labelPrefix = expansion ? "Expanding into" : "Exploring the paper neighborhood for";

  for (const subquestion of targets) {
    if (budget.isOverLimit()) {
      partial.add(subquestion.id);
      break;
    }

    const retrieveKey = `retrieve:${subquestion.id}`;
    budget.activate(retrieveKey);
    budget.setNextStepEstimate("retrieve", retrieveKey);
    state.budget = budget.getState();

    await postUpdate(state, {
      status: "running",
      active_stage: "retrieving",
      event: evt("retrieval", `${labelPrefix}: ${subquestion.text.slice(0, 80)}`),
      graph_patch: {
        nodes: [
          {
            id: subquestion.id,
            label: clip(subquestion.text),
            type: "subquestion",
            status: "active",
            metadata: expansion
              ? { subquestion: subquestion.text, expansion: true }
              : { subquestion: subquestion.text },
          },
        ],
        edges: [],
      },
      subquestions: subquestionState(state, { activeId: subquestion.id }),
      budget: state.budget,
    });

    const retrievalBudget = budget.availableFor(retrieveKey);
    const branch = branchFor(state, subquestion);
    branch.retrieve_budget = retrievalBudget;

    const maxPapers = expansion
      ? state.settings.max_papers_per_subquestion + 2
      : state.settings.max_papers_per_subquestion + (retrievalBudget >= 0.005 ? 2 : 1);
    const maxChunks = expansion
      ? state.settings.max_chunks_per_paper
      : state.settings.max_chunks_per_paper + (retrievalBudget >= 0.008 ? 1 : 0);

    branch.candidate_papers = await retrieveTopPapers(subquestion.text, maxPapers, maxChunks);

    const retrievalSpend = round(
      0.00025 +
        0.00008 * branch.candidate_papers.length +
        0.00002 * branch.candidate_papers.reduce((sum, paper) => sum + (paper.chunks || []).length, 0),
      8,
    );
    budget.recordSpend(retrievalSpend, retrieveKey);
    state.budget = budget.getState();

    await postUpdate(state, {
      status: "running",
      active_stage: "retrieving",
      event: evt(
        "retrieval",
        expansion
          ? `Found ${branch.candidate_papers.length} expansion candidates for ${subquestion.id}.`
          : `Exploring ${branch.candidate_papers.length} candidate papers for ${subquestion.id}.`,
      ),
      graph_patch: {
        nodes: branch.candidate_papers.map((paper) => ({
          id: paper.id,
          label: clip(String(paper.title || paper.id)),
          type: "paper",
          status: "active",
          score: coerceFloat(paper.score, 0),
          metadata: expansion
            ? { title: paper.title || "", branch: "candidate" }
            : {
                title: paper.title || "",
                rank: paper.rank,
                lexical_score: paper.lexical_score,
                branch: "candidate",
              },
        })),
        edges: branch.candidate_papers.map((paper) => ({
          id: `e_${subquestion.id}_${paper.id}`,
          source: subquestion.id,
          target: paper.id,
          type: "retrieves",
          weight: coerceFloat(paper.score, 0),
        })),
      },
      subquestions: subquestionState(state, { activeId: subquestion.id }),
      budget: state.budget,
    });
  }

  writeSets(state, completed, partial);
  state.budget = budget.getState();
  return state;
}

async function stagePrune(state, { expansion }) {
  const budget = BudgetTracker.fromState(state.budget);
  const targets = expansion ? expansionSubquestions(state) : mainSubquestions(state);

  for (const subquestion of targets) {
    const branch = branchFor(state, subquestion);
    const papers = branch.candidate_papers || [];
    if (!papers.length) {
      continue;
    }

    const retrieveKey = `retrieve:${subquestion.id}`;
    budget.activate(retrieveKey);

    let keepCount = Math.min(state.settings.max_papers_per_subquestion, papers.length);
    if (!expansion) {
      if (branch.retrieve_budget >= 0.01) {
        keepCount = Math.min(papers.length, keepCount + 1);
      }
      if (papers.length && coerceFloat(papers[0]?.score, 0) < 0.22) {
        keepCount = Math.min(papers.length, Math.max(2, keepCount));
      }
    }

    branch.retained_papers = papers.slice(0, keepCount);
    branch.pruned_papers = papers.slice(keepCount);

    await postUpdate(state, {
      status: "running",
      active_stage: "retrieving",
      event: evt(
        "retrieval",
        expansion
          ? `Expansion ${subquestion.id}: pruned ${branch.pruned_papers.length}, kept ${branch.retained_papers.length}.`
          : `Pruned ${branch.pruned_papers.length} paper branches and kept ${branch.retained_papers.length} for deeper reading.`,
      ),
      graph_patch: {
        nodes: [
          ...branch.pruned_papers.map((paper) => ({
            id: paper.id,
            label: clip(String(paper.title || paper.id)),
            type: "paper",
            status: "discarded",
            score: coerceFloat(paper.score, 0),
            metadata: expansion
              ? { title: paper.title || "", branch: "pruned" }
              : {
                  title: paper.title || "",
                  rank: paper.rank,
                  lexical_score: paper.lexical_score,
                  branch: "pruned",
                },
          })),
          ...branch.retained_papers.map((paper) => ({
            id: paper.id,
            label: clip(String(paper.title || paper.id)),
            type: "paper",
            status: "active",
            score: coerceFloat(paper.score, 0),
            metadata: expansion
              ? { title: paper.title || "", branch: "retained" }
              : {
                  title: paper.title || "",
                  rank: paper.rank,
                  lexical_score: paper.lexical_score,
                  branch: "retained",
                },
          })),
        ],
        edges: [],
      },
      subquestions: subquestionState(state, { activeId: subquestion.id }),
      budget: budget.getState(),
    });

    budget.complete(retrieveKey);
  }

  state.budget = budget.getState();
  return state;
}

async function runExtractionForSubquestion(state, budget, subquestion, { expansion }) {
  const completed = getCompletedSet(state);
  const partial = getPartialSet(state);
  const branch = branchFor(state, subquestion);
  const extractKey = `extract:${subquestion.id}`;
  const retainedPapers = branch.retained_papers || [];
  const prunedPapers = branch.pruned_papers || [];
  const candidatePapers = branch.candidate_papers || [];

  budget.activate(extractKey);
  budget.setNextStepEstimate("extract", extractKey);
  state.budget = budget.getState();

  branch.seed_findings = buildSeedFindings(
    subquestion,
    retainedPapers,
    Math.max(2, state.settings.max_papers_per_subquestion),
  );

  if (branch.seed_findings.length) {
    await postUpdate(state, {
      status: "running",
      active_stage: "extracting",
      event: evt(
        "extraction",
        expansion
          ? `Expansion ${subquestion.id}: drafted ${branch.seed_findings.length} candidate findings.`
          : `Drafted ${branch.seed_findings.length} candidate findings from retained papers.`,
      ),
      graph_patch: {
        nodes: branch.seed_findings.map((seed) => ({
          id: seed.candidate_id,
          label: clip(seed.claim),
          type: "finding",
          status: "active",
          score: coerceFloat(seed.confidence, 0.5),
          metadata: { phase: "candidate", source_ids: seed.source_ids },
        })),
        edges: branch.seed_findings.flatMap((seed) =>
          sourceEdges(seed.candidate_id, seed.source_ids, coerceFloat(seed.confidence, 0.5)),
        ),
      },
      subquestions: subquestionState(state, { activeId: subquestion.id }),
      budget: state.budget,
    });
  }

  const extractedRaw = [];
  const extractRounds =
    !expansion && budget.availableFor(extractKey) >= 0.01 && retainedPapers.length > 1 ? 2 : 1;

  for (let roundIndex = 0; roundIndex < extractRounds; roundIndex += 1) {
    const batchStart = roundIndex;
    const batch = retainedPapers.slice(batchStart, batchStart + Math.min(3, retainedPapers.length));
    if (!batch.length) {
      continue;
    }
    if (budget.availableFor(extractKey) < Math.max(estimateStepCost("extract") * 0.3, 0.0015)) {
      break;
    }

    const context = batch
      .map((paper) => `[${paper.id}] ${paper.title}\n${(paper.chunks || []).join("\n")}`)
      .join("\n\n");
    const seedText =
      branch.seed_findings
        .map((seed) =>
          expansion
            ? `- [${seed.candidate_id}] ${seed.claim}`
            : `- [${seed.candidate_id}] ${seed.claim} (sources: ${seed.source_ids.join(", ")})`,
        )
        .join("\n") || (expansion ? "- No seed findings." : "- No seed findings drafted.");

    let parsed = [];
    let inputTokens = 0;
    let outputTokens = 0;

    if (TEST_MODE) {
      parsed = testExtractFindings(subquestion, batch, branch.seed_findings);
      [inputTokens, outputTokens] = syntheticUsage("extract");
    } else if (expansion) {
      const [raw, inTok, outTok] = await chat(
        [
          {
            role: "system",
            content:
              'Extract up to 3 grounded findings. Return ONLY a JSON array: {"claim": str, "source_ids": [paper_id], "confidence": float, "candidate_ids": [seed_id]}.',
          },
          {
            role: "user",
            content: `Subquestion: ${subquestion.text}\n\nCandidate findings:\n${seedText}\n\nPaper context:\n${context}`,
          },
        ],
        520,
      );
      parsed = JSON.parse(stripJson(raw));
      if (!Array.isArray(parsed)) {
        parsed = [];
      }
      inputTokens = inTok;
      outputTokens = outTok;
    } else {
      const [raw, inTok, outTok] = await chat(
        [
          {
            role: "system",
            content:
              'Extract up to 3 grounded findings from the shortlisted papers. Return ONLY a JSON array of objects with keys: {"claim": str, "source_ids": [paper_id], "confidence": float, "candidate_ids": [seed_id]}. If the evidence is weak, return a diagnostic finding about weak corpus match instead of inventing facts.',
          },
          {
            role: "user",
            content: `Subquestion: ${subquestion.text}\n\nCandidate findings:\n${seedText}\n\nPaper context:\n${context}`,
          },
        ],
        520,
      );
      parsed = JSON.parse(stripJson(raw));
      if (!Array.isArray(parsed)) {
        throw new Error(`Extraction response for ${subquestion.id} was not a JSON array.`);
      }
      inputTokens = inTok;
      outputTokens = outTok;
    }

    budget.recordSpend(computeOpenAICost(GPT4O, inputTokens, outputTokens), extractKey);
    extractedRaw.push(...parsed.filter((item) => item && typeof item === "object"));
  }

  let mergedRaw = dedupeFindings(extractedRaw);
  if (!mergedRaw.length) {
    mergedRaw = [diagnosticFinding(subquestion, candidatePapers)];
  }

  const selectedCandidateIds = new Set(
    mergedRaw.flatMap((finding) => (Array.isArray(finding.candidate_ids) ? finding.candidate_ids : [])),
  );

  const seedStatusNodes = branch.seed_findings.map((seed) => ({
    id: seed.candidate_id,
    label: clip(seed.claim),
    type: "finding",
    status: selectedCandidateIds.has(seed.candidate_id) ? "completed" : "discarded",
    score: coerceFloat(seed.confidence, 0.5),
    metadata: { phase: "candidate", source_ids: seed.source_ids },
  }));

  const newFindings = [];
  const findingNodes = [];
  const findingEdges = [];

  for (const [index, rawFinding] of mergedRaw.slice(0, 3).entries()) {
    let sourceIds = [...(rawFinding.source_ids || [])].filter((sourceId) =>
      [...retainedPapers, ...prunedPapers].some((paper) => paper.id === sourceId),
    );
    if (!sourceIds.length && retainedPapers.length) {
      sourceIds = [retainedPapers[Math.min(index, retainedPapers.length - 1)].id];
    }
    const claim = claimFromChunk(String(rawFinding.claim || ""));
    if (!claim) {
      continue;
    }

    const finding = {
      id: `f_${subquestion.id}_${index}`,
      subquestion_id: subquestion.id,
      claim,
      source_ids: sourceIds,
      confidence: round(coerceFloat(rawFinding.confidence, 0.62), 2),
      created_at: now(),
    };
    addFinding(state, finding);
    newFindings.push(finding);
    findingNodes.push({
      id: finding.id,
      label: clip(finding.claim),
      type: "finding",
      status: "completed",
      score: finding.confidence,
      metadata: { source_ids: finding.source_ids, phase: "retained" },
    });
    findingEdges.push(...sourceEdges(finding.id, finding.source_ids, finding.confidence));
  }

  if (!newFindings.length) {
    const diagnostic = diagnosticFinding(subquestion, candidatePapers);
    const finding = {
      id: `f_${subquestion.id}_0`,
      subquestion_id: subquestion.id,
      claim: diagnostic.claim,
      source_ids: diagnostic.source_ids,
      confidence: diagnostic.confidence,
      created_at: now(),
    };
    addFinding(state, finding);
    newFindings.push(finding);
    findingNodes.push({
      id: finding.id,
      label: clip(finding.claim),
      type: "finding",
      status: "completed",
      score: finding.confidence,
      metadata: { source_ids: finding.source_ids, phase: "retained" },
    });
    findingEdges.push(...sourceEdges(finding.id, finding.source_ids, finding.confidence));
  }

  completed.add(subquestion.id);
  writeSets(state, completed, partial);
  budget.complete(extractKey);
  state.budget = budget.getState();

  await postUpdate(state, {
    status: "running",
    active_stage: "extracting",
    event: evt(
      "extraction",
      expansion
        ? `Expansion ${subquestion.id}: retained ${newFindings.length} findings.`
        : `Retained ${newFindings.length} findings after pruning candidate branches for ${subquestion.id}.`,
    ),
    graph_patch: {
      nodes: [
        {
          id: subquestion.id,
          label: clip(subquestion.text),
          type: "subquestion",
          status: "completed",
          metadata: expansion
            ? { subquestion: subquestion.text, expansion: true }
            : { subquestion: subquestion.text },
        },
        ...seedStatusNodes,
        ...findingNodes,
      ],
      edges: findingEdges,
    },
    subquestions: subquestionState(state),
    new_findings: newFindings,
    budget: state.budget,
  });
}

async function stageExtract(state, { expansion }) {
  const budget = BudgetTracker.fromState(state.budget);
  const partial = getPartialSet(state);
  const targets = expansion ? expansionSubquestions(state) : mainSubquestions(state);

  for (const subquestion of targets) {
    if (budget.isOverLimit()) {
      partial.add(subquestion.id);
      writeSets(state, getCompletedSet(state), partial);
      break;
    }
    const branch = branchFor(state, subquestion);
    if (!(branch.retained_papers || []).length && !(branch.candidate_papers || []).length) {
      continue;
    }
    await runExtractionForSubquestion(state, budget, subquestion, { expansion });
  }

  state.budget = budget.getState();
  return state;
}

async function stagePlanExpansion(state) {
  const budget = BudgetTracker.fromState(state.budget);
  const retained = getFindings(state);
  const budgetFractionUsed = budget.spentUsd / Math.max(budget.capUsd, 1e-9);

  if (!budget.isOverLimit() && budgetFractionUsed < 0.65 && retained.length >= 2) {
    const nExpand = budgetFractionUsed < 0.4 ? 2 : 1;
    const topic = String(state.query || "").trim().replace(/[?.!]+$/, "");
    let expansionTexts = [];

    if (TEST_MODE) {
      expansionTexts = [
        `What methodological limitations affect evidence on ${topic.slice(0, 55)}?`,
        `What practical implications does evidence on ${topic.slice(0, 55)} suggest?`,
      ].slice(0, nExpand);
    } else {
      const findingsSummary = retained
        .slice(0, 5)
        .map((finding) => `- ${finding.claim}`)
        .join("\n");
      const [raw, inputTokens, outputTokens] = await chat(
        [
          {
            role: "system",
            content: `Generate ${nExpand} follow-up subquestion(s) that deepen research coverage. Return ONLY a JSON array of strings.`,
          },
          {
            role: "user",
            content: `Query: ${state.query}\n\nInitial findings:\n${findingsSummary}`,
          },
        ],
        180,
      );
      const parsed = JSON.parse(stripJson(raw));
      expansionTexts = Array.isArray(parsed) ? parsed : [];
      budget.recordSpend(computeOpenAICost(GPT4O, inputTokens, outputTokens), "synthesize");
    }

    const baseIndex = state.subquestions.length;
    const expansionSubquestionList = expansionTexts
      .slice(0, nExpand)
      .map((text, index) => String(text || "").trim())
      .filter(Boolean)
      .map((text, index) => ({
        id: `sq_${baseIndex + index}`,
        text,
        expansion: true,
      }));

    if (expansionSubquestionList.length) {
      const synthReserve = budget.capUsd * 0.2;
      const expansionPool = Math.max(0, budget.capUsd - budget.spentUsd - synthReserve);
      const perExpansion = round(expansionPool / Math.max(expansionSubquestionList.length, 1), 6);

      for (const subquestion of expansionSubquestionList) {
        budget.upsertAllocation(`retrieve:${subquestion.id}`, `Expand retrieve ${subquestion.id}`, round(perExpansion * 0.42, 6));
        budget.upsertAllocation(`extract:${subquestion.id}`, `Expand extract ${subquestion.id}`, round(perExpansion * 0.58, 6));
      }

      state.subquestions.push(...expansionSubquestionList);
      state.budget = budget.getState();

      await postUpdate(state, {
        status: "running",
        active_stage: "expanding",
        event: evt("planning", `Budget remaining - deepening with ${expansionSubquestionList.length} expansion subquestion(s).`),
        graph_patch: {
          nodes: expansionSubquestionList.map((subquestion) => ({
            id: subquestion.id,
            label: clip(subquestion.text),
            type: "subquestion",
            status: "idle",
            metadata: { subquestion: subquestion.text, expansion: true },
          })),
          edges: expansionSubquestionList.map((subquestion) => ({
            id: `e_q_${subquestion.id}`,
            source: "q_0",
            target: subquestion.id,
            type: "decomposes_to",
          })),
        },
        subquestions: subquestionState(state),
        budget: state.budget,
      });
    }
  }

  state.budget = budget.getState();
  return state;
}

async function stageSynthesize(state) {
  const budget = BudgetTracker.fromState(state.budget);
  const retained = getFindings(state);
  budget.activate("synthesize");
  budget.setNextStepEstimate("synthesize", "synthesize");

  let finalAnswer;
  let status = "partial";

  if (!retained.length) {
    finalAnswer = {
      text: "The run completed without retaining any grounded findings to synthesize.",
      citations: [],
      uncertainty: "high",
    };
  } else {
    if (budget.availableFor("synthesize") < Math.max(estimateStepCost("synthesize") * 0.2, 0.001)) {
      throw new Error("Budget exhausted before synthesis could run.");
    }

    if (TEST_MODE) {
      finalAnswer = testSynthesize(state.query, retained);
      const [inputTokens, outputTokens] = syntheticUsage("synthesize");
      budget.recordSpend(computeOpenAICost(GPT4O, inputTokens, outputTokens), "synthesize");
    } else {
      const findingsText = retained
        .map((finding) => `- [${finding.id}] (${finding.confidence.toFixed(2)}) ${finding.claim}`)
        .join("\n");
      const [raw, inputTokens, outputTokens] = await chat(
        [
          {
            role: "system",
            content:
              'Synthesize a concise research answer grounded only in the retained findings. Return JSON: {"text": str, "citations": [finding_id], "uncertainty": "low"|"medium"|"high"}.',
          },
          {
            role: "user",
            content: `Query: ${state.query}\n\nRetained findings:\n${findingsText}`,
          },
        ],
        650,
      );
      const parsed = JSON.parse(stripJson(raw));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Synthesis response was not a JSON object.");
      }
      finalAnswer = {
        text: parsed.text || raw,
        citations: Array.isArray(parsed.citations) ? parsed.citations : retained.slice(0, 4).map((finding) => finding.id),
        uncertainty: parsed.uncertainty || "medium",
      };
      budget.recordSpend(computeOpenAICost(GPT4O, inputTokens, outputTokens), "synthesize");
    }

    status = retained.some((finding) => finding.confidence >= 0.55) ? "completed" : "partial";
  }

  budget.complete("synthesize");
  state.final_answer = finalAnswer;
  state.status = status;
  state.active_stage = "completed";
  state.budget = budget.getState();

  await postUpdate(state, {
    status,
    active_stage: "completed",
    event: evt("synthesis", "Research complete. Final answer synthesized from retained branches."),
    subquestions: subquestionState(state),
    final_answer: finalAnswer,
    budget: state.budget,
  });

  return state;
}

async function postFailure(state, error) {
  if (!state || !state.session_id || !state.fastapi_webhook_url) {
    return;
  }
  const budget = BudgetTracker.fromState(state.budget);
  state.status = "failed";
  state.active_stage = "failed";
  state.final_answer = {
    text: "The research pipeline failed before it could finish synthesizing an answer.",
    citations: [],
    uncertainty: "high",
  };

  try {
    await postUpdate(state, {
      status: "failed",
      active_stage: "failed",
      event: evt("error", `Pipeline failed: ${error.message || String(error)}`),
      subquestions: subquestionState(state),
      budget: budget.getState(),
      final_answer: state.final_answer,
    });
  } catch (postError) {
    console.error(postError);
  }
}

async function runStage(stage, state) {
  switch (stage) {
    case "decompose":
      return stageDecompose(state);
    case "retrieve_main":
      return stageRetrieve(state, { expansion: false });
    case "prune_main":
      return stagePrune(state, { expansion: false });
    case "extract_main":
      return stageExtract(state, { expansion: false });
    case "plan_expansion":
      return stagePlanExpansion(state);
    case "retrieve_expansion":
      return stageRetrieve(state, { expansion: true });
    case "prune_expansion":
      return stagePrune(state, { expansion: true });
    case "extract_expansion":
      return stageExtract(state, { expansion: true });
    case "synthesize":
      return stageSynthesize(state);
    default:
      throw new Error(`Unknown stage: ${stage}`);
  }
}

module.exports = {
  TEST_MODE,
  postFailure,
  runStage,
};
