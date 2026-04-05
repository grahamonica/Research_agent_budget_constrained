/* Purpose: Own the entire React dashboard, including session state, API calls, live updates, graph display, detail panel, and event log. */

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

export type SessionStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed";
type ConnectionStatus = "idle" | "connecting" | "live" | "closed";
export type GraphNodeType =
  | "query"
  | "subquestion"
  | "category"
  | "paper"
  | "finding"
  | "final";
export type GraphNodeStatus = "idle" | "active" | "completed" | "discarded";
export type GraphEdgeType =
  | "decomposes_to"
  | "routes_to"
  | "retrieves"
  | "supports";

export type BudgetState = {
  cap_usd: number;
  spent_usd: number;
  remaining_usd: number;
  estimated_next_step_usd: number;
};

export type Subquestion = {
  id: string;
  text: string;
  status: "pending" | "running" | "completed" | "partial";
};

export type GraphNode = {
  id: string;
  label: string;
  type: GraphNodeType;
  status: GraphNodeStatus;
  score: number | null;
  metadata: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  weight: number | null;
};

export type GraphSnapshot = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type FindingCard = {
  id: string;
  subquestion_id: string;
  claim: string;
  source_ids: string[];
  confidence: number;
  created_at: string;
};

export type FinalAnswer = {
  text: string;
  citations: string[];
  uncertainty: string;
};

export type SessionEvent = {
  id: string;
  stage: string;
  message: string;
  created_at: string;
};

export type SessionSnapshot = {
  session_id: string;
  query: string;
  status: SessionStatus;
  active_stage: string;
  budget: BudgetState;
  subquestions: Subquestion[];
  graph: GraphSnapshot;
  findings: FindingCard[];
  final_answer: FinalAnswer | null;
  events: SessionEvent[];
  created_at: string;
  updated_at: string;
};

export type CreateSessionResponse = {
  session_id: string;
  status: SessionStatus;
  stream_url: string;
  snapshot: SessionSnapshot;
};

export type SessionUpdateEvent = {
  type: "session_updated" | "session_completed" | "session_failed";
  session_id: string;
  snapshot: SessionSnapshot;
};

export const DEFAULT_QUERY =
  "What are the main limitations of retrieval-augmented generation systems?";

const DEFAULT_FORM = {
  query: DEFAULT_QUERY,
  budget_cap_usd: "0.05",
  max_subquestions: "4",
  max_papers_per_subquestion: "3",
  max_chunks_per_paper: "5",
};

export const DEMO_SNAPSHOT: SessionSnapshot = {
  session_id: "demo_session",
  query: DEFAULT_QUERY,
  status: "running",
  active_stage: "retrieving_papers",
  budget: {
    cap_usd: 0.05,
    spent_usd: 0.018,
    remaining_usd: 0.032,
    estimated_next_step_usd: 0.004,
  },
  subquestions: [
    {
      id: "sq_1",
      text: "What happens when retrieval misses relevant evidence?",
      status: "completed",
    },
    {
      id: "sq_2",
      text: "How does ranking noise affect downstream synthesis?",
      status: "running",
    },
    {
      id: "sq_3",
      text: "What tradeoffs appear when the corpus is incomplete?",
      status: "pending",
    },
  ],
  graph: {
    nodes: [
      {
        id: "q_1",
        label: "RAG limitations",
        type: "query",
        status: "completed",
        score: 1,
        metadata: { title: "Main research question" },
      },
      {
        id: "sq_1",
        label: "Retrieval misses",
        type: "subquestion",
        status: "completed",
        score: 0.95,
        metadata: { stage: "planned" },
      },
      {
        id: "sq_2",
        label: "Ranking noise",
        type: "subquestion",
        status: "active",
        score: 0.9,
        metadata: { stage: "active" },
      },
      {
        id: "cat_1",
        label: "Failure modes",
        type: "category",
        status: "completed",
        score: 0.88,
        metadata: { similarity: 0.88 },
      },
      {
        id: "paper_1",
        label: "Paper A",
        type: "paper",
        status: "completed",
        score: 0.81,
        metadata: { year: 2024 },
      },
      {
        id: "paper_2",
        label: "Paper B",
        type: "paper",
        status: "active",
        score: 0.79,
        metadata: { year: 2023 },
      },
      {
        id: "find_1",
        label: "Grounded but incomplete answers",
        type: "finding",
        status: "completed",
        score: 0.83,
        metadata: { confidence: 0.83 },
      },
      {
        id: "final_1",
        label: "Final answer",
        type: "final",
        status: "idle",
        score: null,
        metadata: {},
      },
    ],
    edges: [
      {
        id: "e_1",
        source: "q_1",
        target: "sq_1",
        type: "decomposes_to",
        weight: 1,
      },
      {
        id: "e_2",
        source: "q_1",
        target: "sq_2",
        type: "decomposes_to",
        weight: 1,
      },
      {
        id: "e_3",
        source: "sq_1",
        target: "cat_1",
        type: "routes_to",
        weight: 0.88,
      },
      {
        id: "e_4",
        source: "cat_1",
        target: "paper_1",
        type: "retrieves",
        weight: 0.81,
      },
      {
        id: "e_5",
        source: "cat_1",
        target: "paper_2",
        type: "retrieves",
        weight: 0.79,
      },
      {
        id: "e_6",
        source: "paper_1",
        target: "find_1",
        type: "supports",
        weight: 0.83,
      },
      {
        id: "e_7",
        source: "find_1",
        target: "final_1",
        type: "supports",
        weight: 0.83,
      },
    ],
  },
  findings: [
    {
      id: "find_1",
      subquestion_id: "sq_1",
      claim: "Retrieval misses can produce answers that look grounded but omit critical evidence.",
      source_ids: ["paper_1", "paper_2"],
      confidence: 0.83,
      created_at: "2026-04-05T14:00:15Z",
    },
  ],
  final_answer: null,
  events: [
    {
      id: "evt_1",
      stage: "planning",
      message: "Created 3 subquestions.",
      created_at: "2026-04-05T14:00:03Z",
    },
    {
      id: "evt_2",
      stage: "routing",
      message: "Routed subquestion 1 into failure modes.",
      created_at: "2026-04-05T14:00:06Z",
    },
    {
      id: "evt_3",
      stage: "retrieval",
      message: "Retrieved 2 papers for the active subquestion.",
      created_at: "2026-04-05T14:00:10Z",
    },
  ],
  created_at: "2026-04-05T14:00:00Z",
  updated_at: "2026-04-05T14:00:10Z",
};

export function formatMoney(value: number): string {
  return `$${value.toFixed(3)}`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function isTerminalStatus(status: SessionStatus): boolean {
  return status === "completed" || status === "partial" || status === "failed";
}

export function buildGraphLevels(graph: GraphSnapshot): GraphNode[][] {
  const order: GraphNodeType[] = [
    "query",
    "subquestion",
    "category",
    "paper",
    "finding",
    "final",
  ];

  return order
    .map((type) => graph.nodes.filter((node) => node.type === type))
    .filter((nodes) => nodes.length > 0);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function nodeColor(type: GraphNodeType): string {
  switch (type) {
    case "query":
      return "node-query";
    case "subquestion":
      return "node-subquestion";
    case "category":
      return "node-category";
    case "paper":
      return "node-paper";
    case "finding":
      return "node-finding";
    case "final":
      return "node-final";
    default:
      return "node-query";
  }
}

function statusTone(status: GraphNodeStatus): string {
  switch (status) {
    case "active":
      return "status-active";
    case "completed":
      return "status-completed";
    case "discarded":
      return "status-discarded";
    default:
      return "status-idle";
  }
}

async function createSession(payload: {
  query: string;
  budget_cap_usd: number;
  max_subquestions: number;
  max_papers_per_subquestion: number;
  max_chunks_per_paper: number;
}): Promise<CreateSessionResponse> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Failed to create session (${response.status})`);
  }

  return (await response.json()) as CreateSessionResponse;
}

async function getSession(sessionId: string): Promise<SessionSnapshot> {
  const response = await fetch(`/api/session/${sessionId}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch session (${response.status})`);
  }

  return (await response.json()) as SessionSnapshot;
}

export default function App() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [session, setSession] = useState<SessionSnapshot | null>(DEMO_SNAPSHOT);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    DEMO_SNAPSHOT.graph.nodes[0]?.id ?? null,
  );
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }

    if (
      selectedNodeId &&
      session.graph.nodes.some((node) => node.id === selectedNodeId)
    ) {
      return;
    }

    setSelectedNodeId(session.graph.nodes[0]?.id ?? null);
  }, [selectedNodeId, session]);

  const selectedNode = useMemo(() => {
    if (!session || !selectedNodeId) {
      return null;
    }

    return session.graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [selectedNodeId, session]);

  const levels = useMemo(
    () => (session ? buildGraphLevels(session.graph) : []),
    [session],
  );

  const connectionLabel =
    connectionStatus === "idle" && session?.session_id === "demo_session"
      ? "demo"
      : connectionStatus;

  const openStream = (streamUrl: string, sessionId: string) => {
    eventSourceRef.current?.close();
    setConnectionStatus("connecting");

    const source = new EventSource(streamUrl);
    eventSourceRef.current = source;

    source.onopen = () => {
      setConnectionStatus("live");
      setError(null);
    };

    source.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data) as SessionUpdateEvent;
        if (parsed.session_id !== sessionId) {
          return;
        }

        setSession(parsed.snapshot);

        if (isTerminalStatus(parsed.snapshot.status)) {
          setConnectionStatus("closed");
          source.close();
          eventSourceRef.current = null;
        }
      } catch {
        setError("Received an unreadable live update payload.");
      }
    };

    source.onerror = async () => {
      setConnectionStatus("closed");
      source.close();
      eventSourceRef.current = null;

      try {
        const latest = await getSession(sessionId);
        setSession(latest);
      } catch {
        setError(
          "Live updates disconnected and the latest session snapshot could not be fetched.",
        );
      }
    };
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setIsSubmitting(true);
    setError(null);

    try {
      const payload = {
        query: form.query.trim(),
        budget_cap_usd: Number(form.budget_cap_usd),
        max_subquestions: Number(form.max_subquestions),
        max_papers_per_subquestion: Number(form.max_papers_per_subquestion),
        max_chunks_per_paper: Number(form.max_chunks_per_paper),
      };

      const created = await createSession(payload);
      setSession(created.snapshot);
      setSelectedNodeId(created.snapshot.graph.nodes[0]?.id ?? null);
      openStream(created.stream_url, created.session_id);
    } catch (submissionError) {
      const message =
        submissionError instanceof Error
          ? submissionError.message
          : "Failed to create the research session.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Budget-Constrained Research Agent</p>
          <h1>Live research state over FastAPI + n8n</h1>
          <p className="hero-copy">
            React starts the session, FastAPI owns the state, n8n drives the
            workflow, and the UI updates through a live session stream.
          </p>
        </div>
        <div className="hero-badges">
          <span className="badge">{`Connection: ${connectionLabel}`}</span>
          <span className={`badge badge-status status-${session?.status ?? "queued"}`}>
            {session?.status ?? "idle"}
          </span>
          <span className="badge">{session?.active_stage ?? "not started"}</span>
        </div>
      </header>

      <main className="dashboard">
        <section className="panel panel-form">
          <div className="panel-header">
            <h2>Start Session</h2>
            <p>Send a query to `POST /api/session` and subscribe to the returned stream.</p>
          </div>

          <form className="query-form" onSubmit={handleSubmit}>
            <label className="field field-query">
              <span>Research Query</span>
              <textarea
                value={form.query}
                onChange={(event) =>
                  setForm((current) => ({ ...current, query: event.target.value }))
                }
                rows={4}
                placeholder="Ask a research question..."
              />
            </label>

            <div className="field-grid">
              <label className="field">
                <span>Budget</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.budget_cap_usd}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      budget_cap_usd: event.target.value,
                    }))
                  }
                />
              </label>

              <label className="field">
                <span>Subquestions</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.max_subquestions}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      max_subquestions: event.target.value,
                    }))
                  }
                />
              </label>

              <label className="field">
                <span>Papers / Subquestion</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.max_papers_per_subquestion}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      max_papers_per_subquestion: event.target.value,
                    }))
                  }
                />
              </label>

              <label className="field">
                <span>Chunks / Paper</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.max_chunks_per_paper}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      max_chunks_per_paper: event.target.value,
                    }))
                  }
                />
              </label>
            </div>

            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Starting..." : "Start Research Session"}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  eventSourceRef.current?.close();
                  eventSourceRef.current = null;
                  setConnectionStatus("idle");
                  setSession(DEMO_SNAPSHOT);
                  setSelectedNodeId(DEMO_SNAPSHOT.graph.nodes[0]?.id ?? null);
                  setError(null);
                }}
              >
                Load Demo State
              </button>
            </div>

            {error ? <p className="error-banner">{error}</p> : null}
          </form>
        </section>

        <section className="panel panel-topbar">
          <div className="panel-header">
            <h2>Session Overview</h2>
            <p>Everything the frontend needs comes from the current session snapshot.</p>
          </div>

          {session ? (
            <div className="overview-grid">
              <div className="metric-card">
                <span className="metric-label">Session ID</span>
                <strong>{session.session_id}</strong>
              </div>
              <div className="metric-card">
                <span className="metric-label">Budget Used</span>
                <strong>{formatMoney(session.budget.spent_usd)}</strong>
              </div>
              <div className="metric-card">
                <span className="metric-label">Remaining</span>
                <strong>{formatMoney(session.budget.remaining_usd)}</strong>
              </div>
              <div className="metric-card">
                <span className="metric-label">Next Step</span>
                <strong>{formatMoney(session.budget.estimated_next_step_usd)}</strong>
              </div>
            </div>
          ) : (
            <p className="empty-state">Start a session to populate the dashboard.</p>
          )}
        </section>

        <section className="panel panel-graph">
          <div className="panel-header">
            <h2>Knowledge Graph</h2>
            <p>Nodes come from `snapshot.graph.nodes`; edges come from `snapshot.graph.edges`.</p>
          </div>

          {session ? (
            <>
              <div className="graph-levels">
                {levels.map((level, index) => (
                  <div className="graph-column" key={`level-${index}`}>
                    {level.map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        className={[
                          "node-card",
                          nodeColor(node.type),
                          statusTone(node.status),
                          selectedNodeId === node.id ? "node-selected" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => setSelectedNodeId(node.id)}
                      >
                        <span className="node-type">{node.type}</span>
                        <strong>{node.label}</strong>
                        <span className="node-meta">
                          {node.score !== null
                            ? `score ${formatPercent(node.score)}`
                            : "no score"}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>

              <div className="edge-table">
                <div className="edge-table-head">
                  <span>Edges</span>
                  <span>{session.graph.edges.length}</span>
                </div>
                <div className="edge-table-body">
                  {session.graph.edges.map((edge) => (
                    <div className="edge-row" key={edge.id}>
                      <span>{edge.source}</span>
                      <span>{edge.type}</span>
                      <span>{edge.target}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <p className="empty-state">No session snapshot available.</p>
          )}
        </section>

        <section className="panel panel-side">
          <div className="panel-header">
            <h2>Detail Panel</h2>
            <p>Selected node metadata, retained findings, and the final answer live here.</p>
          </div>

          {session ? (
            <div className="side-stack">
              <article className="detail-card">
                <div className="detail-head">
                  <span>Selected Node</span>
                  <span>{selectedNode?.type ?? "none"}</span>
                </div>
                {selectedNode ? (
                  <>
                    <h3>{selectedNode.label}</h3>
                    <p>{`Status: ${selectedNode.status}`}</p>
                    <p>
                      {selectedNode.score !== null
                        ? `Score: ${formatPercent(selectedNode.score)}`
                        : "Score: unavailable"}
                    </p>
                    <pre className="metadata-block">
                      {JSON.stringify(selectedNode.metadata, null, 2)}
                    </pre>
                  </>
                ) : (
                  <p className="empty-state">Select a node to inspect its metadata.</p>
                )}
              </article>

              <article className="detail-card">
                <div className="detail-head">
                  <span>Retained Findings</span>
                  <span>{session.findings.length}</span>
                </div>
                {session.findings.length ? (
                  <div className="finding-list">
                    {session.findings.map((finding) => (
                      <div className="finding-card" key={finding.id}>
                        <strong>{finding.claim}</strong>
                        <p>{`Confidence: ${formatPercent(finding.confidence)}`}</p>
                        <p>{`Sources: ${finding.source_ids.join(", ")}`}</p>
                        <p>{formatDate(finding.created_at)}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="empty-state">No retained findings yet.</p>
                )}
              </article>

              <article className="detail-card">
                <div className="detail-head">
                  <span>Final Answer</span>
                  <span>{session.final_answer ? "ready" : "pending"}</span>
                </div>
                {session.final_answer ? (
                  <>
                    <p className="final-answer">{session.final_answer.text}</p>
                    <p>{`Uncertainty: ${session.final_answer.uncertainty}`}</p>
                    <p>{`Citations: ${session.final_answer.citations.join(", ")}`}</p>
                  </>
                ) : (
                  <p className="empty-state">Final synthesis has not been produced yet.</p>
                )}
              </article>
            </div>
          ) : (
            <p className="empty-state">No session selected.</p>
          )}
        </section>

        <section className="panel panel-events">
          <div className="panel-header">
            <h2>Execution Timeline</h2>
            <p>Events are rendered directly from `snapshot.events`.</p>
          </div>

          {session ? (
            <div className="event-list">
              {session.events.length ? (
                session.events.map((entry) => (
                  <article className="event-card" key={entry.id}>
                    <div className="event-head">
                      <strong>{entry.stage}</strong>
                      <span>{formatDate(entry.created_at)}</span>
                    </div>
                    <p>{entry.message}</p>
                  </article>
                ))
              ) : (
                <p className="empty-state">No events have been emitted yet.</p>
              )}
            </div>
          ) : (
            <p className="empty-state">No execution trace available.</p>
          )}
        </section>
      </main>
    </div>
  );
}
