/* Purpose: Research agent dashboard — sidebar form, network graph canvas, and evidence detail panel. */

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

export type SessionStatus = "queued" | "running" | "completed" | "partial" | "failed";
type ConnectionStatus = "idle" | "connecting" | "live" | "closed";
export type GraphNodeType = "query" | "subquestion" | "category" | "paper" | "finding" | "final";
export type GraphNodeStatus = "idle" | "active" | "completed" | "discarded";
export type GraphEdgeType = "decomposes_to" | "routes_to" | "retrieves" | "supports";

export type BudgetAllocation = {
  key: string;
  label: string;
  allocated_usd: number;
  spent_usd: number;
  remaining_usd: number;
  status: "planned" | "active" | "completed" | "skipped" | "depleted";
};

export type BudgetState = {
  cap_usd: number;
  spent_usd: number;
  remaining_usd: number;
  estimated_next_step_usd: number;
  active_allocation_key?: string | null;
  allocations?: BudgetAllocation[];
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

export type GraphSnapshot = { nodes: GraphNode[]; edges: GraphEdge[] };

export type FindingCard = {
  id: string;
  subquestion_id: string;
  claim: string;
  source_ids: string[];
  confidence: number;
  created_at: string;
};

export type FinalAnswer = { text: string; citations: string[]; uncertainty: string };

export type SessionEvent = { id: string; stage: string; message: string; created_at: string };

export type SessionSnapshot = {
  session_id: string;
  query: string;
  status: SessionStatus;
  active_stage: string;
  budget: BudgetState;
  subquestions: { id: string; text: string; status: string }[];
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

const NODE_W = 164;
const NODE_H = 52;
const TYPE_ORDER: GraphNodeType[] = [
  "query",
  "subquestion",
  "category",
  "paper",
  "finding",
  "final",
];

type Pos = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
const NODE_COLOR: Record<GraphNodeType, string> = {
  query: "#20374d",
  subquestion: "#4f3d7a",
  category: "#00695c",
  paper: "#8b4513",
  finding: "#9f2d2d",
  final: "#7a5a00",
};

export function formatMoney(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function formatPercent(value: number | null | undefined): string {
  return `${Math.round((value ?? 0) * 100)}%`;
}

export function isTerminalStatus(status: SessionStatus): boolean {
  return status === "completed" || status === "partial" || status === "failed";
}

export function buildGraphLevels(graph: GraphSnapshot): GraphNode[][] {
  return TYPE_ORDER
    .map((type) => graph.nodes.filter((node) => node.type === type))
    .filter((level) => level.length > 0);
}

function normalizeAngle(angle: number): number {
  while (angle <= -Math.PI) angle += Math.PI * 2;
  while (angle > Math.PI) angle -= Math.PI * 2;
  return angle;
}

function averageAngles(angles: number[]): number {
  if (angles.length === 0) return 0;
  const x = angles.reduce((sum, angle) => sum + Math.cos(angle), 0);
  const y = angles.reduce((sum, angle) => sum + Math.sin(angle), 0);
  return Math.atan2(y, x);
}

function measureBounds(positions: Map<string, Pos>): Bounds {
  const values = [...positions.values()];
  if (values.length === 0) {
    return { minX: 0, minY: 0, maxX: 480, maxY: 480 };
  }

  return values.reduce<Bounds>(
    (acc, pos) => ({
      minX: Math.min(acc.minX, pos.x),
      minY: Math.min(acc.minY, pos.y),
      maxX: Math.max(acc.maxX, pos.x + NODE_W),
      maxY: Math.max(acc.maxY, pos.y + NODE_H),
    }),
    {
      minX: values[0].x,
      minY: values[0].y,
      maxX: values[0].x + NODE_W,
      maxY: values[0].y + NODE_H,
    },
  );
}

function computeLayout(nodes: GraphNode[], edges: GraphEdge[]) {
  if (nodes.length === 0) {
    return {
      positions: new Map<string, Pos>(),
      bounds: { minX: 0, minY: 0, maxX: 480, maxY: 480 },
    };
  }

  // Radial ring layout: query at center, each node type on its own ring.
  const R_SQ    = 130;  // subquestion ring
  const R_CAT   = 185;  // category ring (rarely used)
  const R_PAPER = 248;  // paper ring
  const R_FIND  = 430;  // finding ring
  const R_FINAL = 78;   // final answer: small offset from center (below)
  const PAPER_MAX_RADIUS = R_FIND - 118;
  const FINDING_MIN_RADIUS = R_PAPER + 118;

  const MARGIN = NODE_W / 2 + 28;
  const CX = R_FIND + MARGIN;  // ≈ 468
  const CY = R_FIND + MARGIN;

  const positions = new Map<string, Pos>();

  // Build parent map: nodeId → [parentIds]
  const parents = new Map<string, string[]>();
  edges.forEach((edge) => {
    parents.set(edge.target, [...(parents.get(edge.target) ?? []), edge.source]);
  });

  const anchors = new Map<string, Pos>();

  const place = (id: string, angle: number, r: number) => {
    positions.set(id, {
      x: CX + r * Math.cos(angle) - NODE_W / 2,
      y: CY + r * Math.sin(angle) - NODE_H / 2,
    });
    anchors.set(id, {
      x: CX + r * Math.cos(angle) - NODE_W / 2,
      y: CY + r * Math.sin(angle) - NODE_H / 2,
    });
  };

  const clampNodeRadius = (node: GraphNode, pos: Pos) => {
    const centerX = pos.x + NODE_W / 2;
    const centerY = pos.y + NODE_H / 2;
    const dx = centerX - CX;
    const dy = centerY - CY;
    const radius = Math.hypot(dx, dy) || 1;
    let targetRadius = radius;

    if (node.type === "paper") {
      targetRadius = Math.min(radius, PAPER_MAX_RADIUS);
    } else if (node.type === "finding") {
      targetRadius = Math.max(radius, FINDING_MIN_RADIUS);
    }

    if (targetRadius === radius) return;
    const scale = targetRadius / radius;
    pos.x = CX + dx * scale - NODE_W / 2;
    pos.y = CY + dy * scale - NODE_H / 2;
  };

  // Query: center
  nodes.filter((n) => n.type === "query").forEach((n) => {
    const pos = { x: CX - NODE_W / 2, y: CY - NODE_H / 2 };
    positions.set(n.id, pos);
    anchors.set(n.id, pos);
  });

  // Final: below center at R_FINAL (angle = π/2)
  nodes.filter((n) => n.type === "final").forEach((n, i) => {
    place(n.id, Math.PI / 2, R_FINAL + i * 72);
  });

  // Subquestions: evenly spaced full circle, starting at top (−π/2)
  const sqNodes = nodes.filter((n) => n.type === "subquestion");
  const sqAngles = new Map<string, number>();
  sqNodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(sqNodes.length, 1) - Math.PI / 2;
    sqAngles.set(n.id, angle);
    place(n.id, angle, R_SQ);
  });

  // Category nodes: grouped by parent sq angle
  const catAngles = new Map<string, number>();
  nodes.filter((n) => n.type === "category").forEach((n, i) => {
    const sqParent = (parents.get(n.id) ?? []).find((pid) => sqAngles.has(pid));
    const angle =
      sqParent != null
        ? (sqAngles.get(sqParent) ?? 0)
        : (2 * Math.PI * i) / Math.max(nodes.filter((x) => x.type === "category").length, 1) - Math.PI / 2;
    catAngles.set(n.id, angle);
    place(n.id, angle, R_CAT);
  });

  // Papers: grouped by parent sq, with shared papers allowed to spread farther from crowded parent angles.
  const paperNodes = nodes.filter((n) => n.type === "paper");
  const papersBySq = new Map<string, GraphNode[]>();
  paperNodes.forEach((n) => {
    const sqParent =
      (parents.get(n.id) ?? []).find((pid) => sqAngles.has(pid) || catAngles.has(pid)) ?? "__orphan__";
    const arr = papersBySq.get(sqParent) ?? [];
    arr.push(n);
    papersBySq.set(sqParent, arr);
  });
  papersBySq.forEach((papers, sqId) => {
    const base = sqAngles.get(sqId) ?? catAngles.get(sqId) ?? 0;
    const span = Math.min(0.52, papers.length * 0.19);
    papers.forEach((n, i) => {
      const parentAngles = (parents.get(n.id) ?? [])
        .map((pid) => sqAngles.get(pid) ?? catAngles.get(pid))
        .filter((angle): angle is number => typeof angle === "number");
      const sharedCount = Math.max(parentAngles.length - 1, 0);
      const anchorAngle = parentAngles.length > 0 ? averageAngles(parentAngles) : base;
      const fanOffset = papers.length > 1 ? (i / (papers.length - 1) - 0.5) * 2 * span : 0;
      const sharedSpread =
        sharedCount > 0
          ? normalizeAngle(base - anchorAngle) * 0.7 + (sharedCount % 2 === 0 ? -1 : 1) * 0.18 * sharedCount
          : 0;
      const radius = Math.min(
        PAPER_MAX_RADIUS,
        R_PAPER + sharedCount * 42 + Math.abs(fanOffset + sharedSpread) * 34,
      );
      place(n.id, anchorAngle + fanOffset + sharedSpread, radius);
    });
  });

  // Findings: grouped by sq parsed from ID (f_{sqId}_{idx} or seed_{sqId}_{idx})
  const findingNodes = nodes.filter((n) => n.type === "finding");
  const findingsBySq = new Map<string, GraphNode[]>();
  findingNodes.forEach((n) => {
    const match = n.id.match(/^(?:f_|seed_)(sq_\d+)/);
    const sqId = match != null ? match[1] : "__orphan__";
    const resolvedSqId = sqAngles.has(sqId) ? sqId : "__orphan__";
    const arr = findingsBySq.get(resolvedSqId) ?? [];
    arr.push(n);
    findingsBySq.set(resolvedSqId, arr);
  });
  findingsBySq.forEach((findings, sqId) => {
    const base = sqAngles.get(sqId) ?? 0;
    const span = Math.min(0.40, findings.length * 0.15);
    findings.forEach((n, i) => {
      const offset = findings.length > 1 ? (i / (findings.length - 1) - 0.5) * 2 * span : 0;
      place(n.id, base + offset, Math.max(R_FIND, FINDING_MIN_RADIUS));
    });
  });

  // Fallback for any unpositioned nodes
  nodes.forEach((n) => {
    if (!positions.has(n.id)) {
      const pos = { x: CX - NODE_W / 2, y: CY + R_FIND + 20 };
      positions.set(n.id, pos);
      anchors.set(n.id, pos);
    }
  });

  // Relax non-central nodes so crowded clusters can spread without losing their general ring placement.
  const movableNodes = nodes.filter((node) => node.type !== "query" && node.type !== "final");
  const minGapX = NODE_W + 24;
  const minGapY = NODE_H + 18;
  for (let iteration = 0; iteration < 28; iteration += 1) {
    for (let i = 0; i < movableNodes.length; i += 1) {
      const left = movableNodes[i];
      const leftPos = positions.get(left.id);
      if (!leftPos) continue;

      for (let j = i + 1; j < movableNodes.length; j += 1) {
        const right = movableNodes[j];
        const rightPos = positions.get(right.id);
        if (!rightPos) continue;

        const dx = (leftPos.x + NODE_W / 2) - (rightPos.x + NODE_W / 2);
        const dy = (leftPos.y + NODE_H / 2) - (rightPos.y + NODE_H / 2);
        const overlapX = minGapX - Math.abs(dx);
        const overlapY = minGapY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        const push = Math.max(overlapX, overlapY) * 0.1 + 1.2;
        const dist = Math.hypot(dx, dy) || 1;
        const pushX = (dx / dist) * push;
        const pushY = (dy / dist) * push;
        leftPos.x += pushX;
        leftPos.y += pushY;
        rightPos.x -= pushX;
        rightPos.y -= pushY;
      }
    }

    movableNodes.forEach((node) => {
      const pos = positions.get(node.id);
      const anchor = anchors.get(node.id);
      if (!pos || !anchor) return;
      pos.x += (anchor.x - pos.x) * 0.08;
      pos.y += (anchor.y - pos.y) * 0.08;
      clampNodeRadius(node, pos);
    });
  }

  const bounds = measureBounds(positions);
  return { positions, bounds };
}

function GraphCanvas({
  graph,
  selectedId,
  onSelect,
}: {
  graph: GraphSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isGraphReady, setIsGraphReady] = useState(false);
  const { positions, bounds } = useMemo(
    () => computeLayout(graph.nodes, graph.edges),
    [graph.nodes, graph.edges],
  );
  const paddedViewBox = useMemo(() => {
    const padding = 72;
    const minX = bounds.minX - padding;
    const minY = bounds.minY - padding;
    const width = Math.max(bounds.maxX - bounds.minX, NODE_W) + padding * 2;
    const height = Math.max(bounds.maxY - bounds.minY, NODE_H) + padding * 2;
    return { minX, minY, width, height };
  }, [bounds]);

  useEffect(() => {
    setIsGraphReady(false);
    const timer = window.setTimeout(() => setIsGraphReady(true), 18);
    return () => window.clearTimeout(timer);
  }, [paddedViewBox.height, paddedViewBox.minX, paddedViewBox.minY, paddedViewBox.width]);

  if (graph.nodes.length === 0) {
    return (
      <div ref={containerRef} className="graph-empty">
        <p>The research network will grow here as the run explores and prunes branches.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="graph-viewport">
      <svg
        width="100%"
        height="100%"
        viewBox={`${paddedViewBox.minX} ${paddedViewBox.minY} ${paddedViewBox.width} ${paddedViewBox.height}`}
        preserveAspectRatio="xMidYMid meet"
        className={`graph-svg ${isGraphReady ? "graph-svg-ready" : ""}`}
      >
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L0,8 L8,4 z" fill="context-stroke" />
        </marker>
      </defs>

      <g className="edge-layer" aria-hidden="true">
      {graph.edges.map((edge) => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) return null;

        const sourceNode = graph.nodes.find((node) => node.id === edge.source);
        const targetNode = graph.nodes.find((node) => node.id === edge.target);
        const isDiscarded = sourceNode?.status === "discarded" || targetNode?.status === "discarded";
        const isHighlighted = selectedId !== null && (edge.source === selectedId || edge.target === selectedId);

        // Directional anchors: exit/enter each node from the side facing the other node.
        const srcCX = source.x + NODE_W / 2;
        const srcCY = source.y + NODE_H / 2;
        const tgtCX = target.x + NODE_W / 2;
        const tgtCY = target.y + NODE_H / 2;
        const dx = tgtCX - srcCX;
        const dy = tgtCY - srcCY;
        const angle = Math.atan2(dy, dx);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const tX = (NODE_W / 2) / (Math.abs(cos) + 0.001);
        const tY = (NODE_H / 2) / (Math.abs(sin) + 0.001);
        const t = Math.min(tX, tY);
        const isMostlyVertical = Math.abs(dy) > Math.abs(dx) * 1.35;
        const startLift = isMostlyVertical && dy > 0 ? 10 : 0;
        const arrowInset = isMostlyVertical ? 6 : 12;
        const x1 = srcCX + cos * Math.max(t - startLift, 0);
        const y1 = srcCY + sin * Math.max(t - startLift, 0);
        const x2 = tgtCX - cos * (t + arrowInset);
        const y2 = tgtCY - sin * (t + arrowInset);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const ctrl = dist * 0.32;
        const cp1x = x1 + cos * ctrl;
        const cp1y = y1 + sin * ctrl;
        const cp2x = x2 - cos * ctrl;
        const cp2y = y2 - sin * ctrl;
        const edgeColor = isDiscarded
          ? "rgba(140,129,117,0.16)"
          : isHighlighted
            ? "rgba(47,38,29,0.62)"
            : "rgba(95,84,71,0.22)";

        return (
          <path
            key={edge.id}
            d={`M ${x1} ${y1} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${x2} ${y2}`}
            fill="none"
            stroke={edgeColor}
            strokeWidth={isHighlighted ? 2.2 : 1.5}
            strokeDasharray={isDiscarded ? "5 5" : undefined}
            markerEnd="url(#arrow)"
          />
        );
      })}
      </g>

      {graph.nodes.map((node) => {
        const pos = positions.get(node.id);
        if (!pos) return null;
        const color = NODE_COLOR[node.type];
        const isSelected = node.id === selectedId;
        const isDiscarded = node.status === "discarded";
        const label = node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label;
        const opacity = isDiscarded ? 0.3 : node.status === "idle" ? 0.58 : 1;
        const phase = typeof node.metadata.phase === "string" ? node.metadata.phase : node.type;

        return (
          <g
            key={node.id}
            onClick={() => onSelect(node.id)}
            style={{ cursor: "pointer", opacity, transition: "opacity 0.55s ease" }}
          >
            {node.status === "active" && (
              <rect
                x={pos.x - 5}
                y={pos.y - 5}
                width={NODE_W + 10}
                height={NODE_H + 10}
                rx={16}
                fill="none"
                stroke={color}
                strokeWidth={1.8}
                strokeOpacity={0.34}
                className="node-pulse-ring"
              />
            )}

            {isSelected && (
              <rect
                x={pos.x - 4}
                y={pos.y - 4}
                width={NODE_W + 8}
                height={NODE_H + 8}
                rx={15}
                fill="#f8f4ec"
                stroke={color}
                strokeOpacity={0.84}
                strokeWidth={2.6}
              />
            )}

            <rect
              x={pos.x}
              y={pos.y}
              width={NODE_W}
              height={NODE_H}
              rx={12}
              fill="#fbf8f2"
              stroke={color}
              strokeWidth={node.status === "active" ? 1.9 : 1.45}
              strokeOpacity={node.status === "completed" ? 0.62 : node.status === "active" ? 0.88 : 0.42}
              strokeDasharray={node.status === "active" ? "6 4" : undefined}
            />

            <rect
              x={pos.x}
              y={pos.y}
              width={6}
              height={NODE_H}
              rx={5}
              fill={color}
              fillOpacity={node.status === "completed" ? 0.82 : node.status === "active" ? 1 : 0.28}
            />

            <text
              x={pos.x + 14}
              y={pos.y + 16}
              fontSize={7.8}
              fill={color}
              fillOpacity={0.58}
              fontFamily="IBM Plex Sans, system-ui, sans-serif"
              fontWeight={700}
              letterSpacing={0.9}
            >
              {String(phase).toUpperCase()}
            </text>

            <text
              x={pos.x + 14}
              y={pos.y + 34}
              fontSize={11.2}
              fill={color}
              fillOpacity={0.92}
              fontFamily="IBM Plex Sans, system-ui, sans-serif"
              fontWeight={550}
            >
              {label}
            </text>

            {node.score !== null && (
              <text
                x={pos.x + NODE_W - 10}
                y={pos.y + 16}
                fontSize={8.2}
                fill={color}
                fillOpacity={0.48}
                fontFamily="IBM Plex Sans, system-ui, sans-serif"
                textAnchor="end"
              >
                {formatPercent(node.score)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
    </div>
  );
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Failed to create session (${response.status})`);
  return response.json() as Promise<CreateSessionResponse>;
}

async function getSession(sessionId: string): Promise<SessionSnapshot> {
  const response = await fetch(`/api/session/${sessionId}`);
  if (!response.ok) throw new Error(`Failed to fetch session (${response.status})`);
  return response.json() as Promise<SessionSnapshot>;
}

function DetailValue({ value }: { value: unknown }) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <span>{String(value)}</span>;
  }
  return <span>{JSON.stringify(value)}</span>;
}

export default function App() {
  const [query, setQuery] = useState("");
  const [budget, setBudget] = useState("0.10");
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<EventSource | null>(null);

  useEffect(() => () => {
    streamRef.current?.close();
  }, []);

  useEffect(() => {
    if (!session) return;
    if (selectedNodeId && session.graph.nodes.some((node) => node.id === selectedNodeId)) return;
    const preferred = session.graph.nodes.find((node) => node.type === "final") ?? session.graph.nodes[0];
    setSelectedNodeId(preferred?.id ?? null);
  }, [selectedNodeId, session]);

  const selectedNode = useMemo(
    () => session?.graph.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [selectedNodeId, session],
  );

  const openStream = (streamUrl: string, sessionId: string) => {
    streamRef.current?.close();
    setConnectionStatus("connecting");
    const source = new EventSource(streamUrl);
    streamRef.current = source;

    source.onopen = () => {
      setConnectionStatus("live");
      setError(null);
    };

    source.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data) as SessionUpdateEvent;
        if (parsed.session_id !== sessionId) return;
        setSession(parsed.snapshot);
        if (isTerminalStatus(parsed.snapshot.status)) {
          setConnectionStatus("closed");
          source.close();
          streamRef.current = null;
        }
      } catch {
        setError("Unreadable live update.");
      }
    };

    source.onerror = async () => {
      setConnectionStatus("closed");
      source.close();
      streamRef.current = null;
      try {
        setSession(await getSession(sessionId));
      } catch {
        setError("Live updates closed and the latest session snapshot could not be fetched.");
      }
    };
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!query.trim()) {
      setError("Enter a research query.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setSession(null);
    setSelectedNodeId(null);

    try {
      const budgetCap = Number(budget);
      const created = await createSession({
        query: query.trim(),
        budget_cap_usd: budgetCap,
        max_subquestions: budgetCap >= 0.30 ? 5 : budgetCap >= 0.15 ? 4 : 3,
        max_papers_per_subquestion: budgetCap >= 0.20 ? 5 : 4,
        max_chunks_per_paper: budgetCap >= 0.40 ? 4 : 3,
      });
      setSession(created.snapshot);
      openStream(created.stream_url, created.session_id);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Failed to start session.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const budgetPct = session
    ? Math.min(1, session.budget.spent_usd / Math.max(session.budget.cap_usd, 0.0001))
    : 0;
  const statusColor =
    session?.status === "running"
      ? "#0d9488"
      : session?.status === "completed"
        ? "#2563eb"
        : session?.status === "partial"
          ? "#d97706"
          : session?.status === "failed"
            ? "#b91c1c"
            : "#78716c";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand-row">
          <span className="brand">Research Agent</span>
          {session && <span className="conn-badge">{connectionStatus}</span>}
        </div>

        {session && (
          <div className="status-row">
            <span className="dot" style={{ background: statusColor }} />
            <span className="status-text" style={{ color: statusColor }}>
              {session.status}
            </span>
            <span className="stage-text">{session.active_stage}</span>
          </div>
        )}

        <form className="query-form" onSubmit={handleSubmit}>
          <label className="field" htmlFor="research-query">
            <span>Research Query</span>
            <textarea
              id="research-query"
              value={query}
              rows={4}
              placeholder="Ask a research question…"
              onChange={(nextEvent) => setQuery(nextEvent.target.value)}
            />
          </label>

          <label className="field" htmlFor="research-budget">
            <span>Budget (USD)</span>
            <input
              id="research-budget"
              type="number"
              min="0.01"
              step="0.01"
              value={budget}
              onChange={(nextEvent) => setBudget(nextEvent.target.value)}
            />
          </label>

          {session && (
            <div className="budget-bar-wrap">
              <div className="budget-numbers">
                <span>{formatMoney(session.budget.spent_usd)} spent</span>
                <span>{formatMoney(session.budget.remaining_usd)} left</span>
              </div>
              <div className="budget-track">
                <div
                  className="budget-fill"
                  style={{
                    width: `${budgetPct * 100}%`,
                    background:
                      budgetPct > 0.85
                        ? "#b91c1c"
                        : budgetPct > 0.6
                          ? "#d97706"
                          : "#2563eb",
                  }}
                />
              </div>
              <div className="budget-next-step">
                Next step estimate: {formatMoney(session.budget.estimated_next_step_usd)}
              </div>
            </div>
          )}

          <button className="btn-primary" type="submit" disabled={isSubmitting || !query.trim()}>
            {isSubmitting ? "Starting…" : "Run Research"}
          </button>

          {error && <p className="error-msg">{error}</p>}
        </form>

        {session?.budget.allocations && session.budget.allocations.length > 0 && (
          <section className="allocation-panel">
            <div className="section-label">
              Sub-Budgets
              <span className="count-badge">{session.budget.allocations.length}</span>
            </div>
            <div className="allocation-list">
              {session.budget.allocations.map((allocation) => (
                <div
                  key={allocation.key}
                  className={`allocation-card allocation-${allocation.status}${
                    session.budget.active_allocation_key === allocation.key ? " allocation-current" : ""
                  }`}
                >
                  <div className="allocation-top">
                    <span className="allocation-label">{allocation.label}</span>
                    <span className="allocation-status">{allocation.status}</span>
                  </div>
                  <div className="allocation-metrics">
                    <span>{formatMoney(allocation.spent_usd)} spent</span>
                    <span>{formatMoney(allocation.allocated_usd)} planned</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {session && session.events.length > 0 && (
          <div className="event-feed">
            {[...session.events].reverse().map((eventItem) => (
              <div key={eventItem.id} className="event-row">
                <span className="ev-stage">{eventItem.stage}</span>
                <span className="ev-msg">{eventItem.message}</span>
              </div>
            ))}
          </div>
        )}
      </aside>

      <main className="graph-canvas">
        {session ? (
          <GraphCanvas graph={session.graph} selectedId={selectedNodeId} onSelect={setSelectedNodeId} />
        ) : (
          <div className="graph-empty">
            <p>Run a query to watch the agent explore papers, prune weak branches, and retain findings.</p>
          </div>
        )}
      </main>

      <aside className="detail-panel">
        {session?.final_answer && (
          <section className={`final-card uncertainty-bg-${session.final_answer.uncertainty}`}>
            <div className="section-label">
              Final Answer
              <span className={`uncertainty uncertainty-${session.final_answer.uncertainty}`}>
                {session.final_answer.uncertainty}
              </span>
            </div>
            <p className="final-text">{session.final_answer.text}</p>
          </section>
        )}

        {session?.subquestions && session.subquestions.length > 0 && (
          <section className="detail-section">
            <div className="section-label">
              Subquestions
              <span className="count-badge">{session.subquestions.length}</span>
            </div>
            <div className="subquestion-list">
              {session.subquestions.map((subquestion) => (
                <div key={subquestion.id} className={`subquestion-card sq-${subquestion.status}`}>
                  <span className="subquestion-status">{subquestion.status}</span>
                  <p>{subquestion.text}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {selectedNode ? (
          <section className="detail-section">
            <div className="detail-type" style={{ color: NODE_COLOR[selectedNode.type] }}>
              {selectedNode.type}
            </div>
            <h3 className="detail-label">{selectedNode.label}</h3>
            <div className="detail-meta">
              <span className={`status-pill status-pill-${selectedNode.status}`}>{selectedNode.status}</span>
              {selectedNode.score !== null && <span className="score-pill">{formatPercent(selectedNode.score)}</span>}
            </div>
            {Object.keys(selectedNode.metadata).length > 0 && (
              <div className="meta-list">
                {Object.entries(selectedNode.metadata).map(([key, value]) => (
                  <div className="meta-row" key={key}>
                    <span className="meta-key">{key}</span>
                    <DetailValue value={value} />
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : (
          !session?.final_answer && <p className="detail-empty">Click a node to inspect the current branch.</p>
        )}

        {session && session.findings.length > 0 && (
          <section className="detail-section">
            <div className="section-label">
              Retained Findings
              <span className="count-badge">{session.findings.length}</span>
            </div>
            <div className="finding-list">
              {session.findings.map((finding) => (
                <div
                  key={finding.id}
                  className={`finding-card${selectedNode?.id === finding.id ? " finding-selected" : ""}`}
                  onClick={() => setSelectedNodeId(finding.id)}
                  role="button"
                >
                  <p className="finding-claim">{finding.claim}</p>
                  <div className="finding-meta">
                    <span>{formatPercent(finding.confidence)} confidence</span>
                    <span>{finding.source_ids.join(", ") || "no sources"}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {!session && <p className="detail-empty">Results will appear here.</p>}
      </aside>
    </div>
  );
}
