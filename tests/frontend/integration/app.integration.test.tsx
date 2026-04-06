import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App, { CreateSessionResponse, SessionUpdateEvent, SessionSnapshot } from "../../../frontend/src/App";

class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emitOpen() {
    this.onopen?.();
  }

  emitMessage(payload: SessionUpdateEvent) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }
}

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    session_id: "sess_001",
    query: "How should the system show pruning in the graph?",
    status: "queued",
    active_stage: "created",
    budget: {
      cap_usd: 0.1,
      spent_usd: 0,
      remaining_usd: 0.1,
      estimated_next_step_usd: 0.002,
      active_allocation_key: null,
      allocations: [],
    },
    subquestions: [],
    graph: { nodes: [], edges: [] },
    findings: [],
    final_answer: null,
    events: [],
    created_at: "2026-04-05T14:00:00Z",
    updated_at: "2026-04-05T14:00:00Z",
    ...overrides,
  };
}

describe("App integration", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    MockEventSource.instances = [];
    vi.restoreAllMocks();
    vi.stubGlobal("EventSource", MockEventSource);
  });

  it("starts empty instead of loading a demo session", () => {
    render(<App />);

    expect(screen.getByRole("button", { name: /run research/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/research query/i)).toHaveValue("");
    expect(
      screen.getByText(/run a query to watch the agent explore papers, prune weak branches, and retain findings/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("demo_session")).not.toBeInTheDocument();
  });

  it("submits a new session request and applies live SSE updates", async () => {
    const createdSnapshot = makeSnapshot({
      graph: {
        nodes: [
          {
            id: "q_0",
            label: "Fresh query",
            type: "query",
            status: "completed",
            score: 1,
            metadata: {},
          },
        ],
        edges: [],
      },
    });

    const createResponse: CreateSessionResponse = {
      session_id: "sess_001",
      status: "queued",
      stream_url: "/api/session/sess_001/stream",
      snapshot: createdSnapshot,
    };

    const liveSnapshot = makeSnapshot({
      status: "running",
      active_stage: "extracting",
      budget: {
        cap_usd: 0.1,
        spent_usd: 0.018,
        remaining_usd: 0.082,
        estimated_next_step_usd: 0.004,
        active_allocation_key: "extract:sq_0",
        allocations: [
          {
            key: "decompose",
            label: "Decompose query",
            allocated_usd: 0.01,
            spent_usd: 0.003,
            remaining_usd: 0.007,
            status: "completed",
          },
          {
            key: "extract:sq_0",
            label: "Extract findings for sq_0",
            allocated_usd: 0.02,
            spent_usd: 0.01,
            remaining_usd: 0.01,
            status: "active",
          },
        ],
      },
      subquestions: [
        { id: "sq_0", text: "What evidence survives pruning?", status: "running" },
      ],
      graph: {
        nodes: [
          {
            id: "q_0",
            label: "Fresh query",
            type: "query",
            status: "completed",
            score: 1,
            metadata: {},
          },
          {
            id: "paper_live",
            label: "Live paper",
            type: "paper",
            status: "active",
            score: 0.8,
            metadata: { branch: "retained", rank: 1 },
          },
        ],
        edges: [
          { id: "edge_live", source: "q_0", target: "paper_live", type: "retrieves", weight: 0.8 },
        ],
      },
      events: [
        {
          id: "evt_live",
          stage: "retrieval",
          message: "Pruned 2 paper branches and kept 2 for deeper reading.",
          created_at: "2026-04-05T14:00:10Z",
        },
      ],
    });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(createResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const user = userEvent.setup();
    const queryBox = screen.getByLabelText(/research query/i);
    await user.type(queryBox, "How should the system handle live session updates?");
    await user.click(screen.getByRole("button", { name: /run research/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/session",
        expect.objectContaining({ method: "POST" }),
      );
    });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toBe("/api/session/sess_001/stream");

    MockEventSource.instances[0]?.emitOpen();
    MockEventSource.instances[0]?.emitMessage({
      type: "session_updated",
      session_id: "sess_001",
      snapshot: liveSnapshot,
    });

    await waitFor(() => {
      expect(screen.getByText(/live paper/i)).toBeInTheDocument();
      expect(screen.getByText(/pruned 2 paper branches and kept 2 for deeper reading/i)).toBeInTheDocument();
      expect(screen.getByText("$0.0180 spent")).toBeInTheDocument();
      expect(screen.getByText(/extract findings for sq_0/i)).toBeInTheDocument();
    });
  });
});
