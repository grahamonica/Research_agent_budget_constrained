import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App, {
  CreateSessionResponse,
  DEMO_SNAPSHOT,
  SessionUpdateEvent,
} from "../../../frontend/src/App";

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
    this.onmessage?.({
      data: JSON.stringify(payload),
    } as MessageEvent<string>);
  }
}

describe("App integration", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    MockEventSource.instances = [];
    vi.restoreAllMocks();
    vi.stubGlobal("EventSource", MockEventSource);
  });

  it("renders the demo snapshot by default", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: /live research state over fastapi \+ n8n/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("demo_session")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /subquestion retrieval misses score 95%/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/created 3 subquestions\./i)).toBeInTheDocument();
  });

  it("submits a new session request and applies live SSE updates", async () => {
    const createdSnapshot = {
      ...DEMO_SNAPSHOT,
      session_id: "sess_001",
      status: "queued" as const,
      active_stage: "created",
      graph: {
        nodes: [
          {
            id: "q_new",
            label: "Fresh query",
            type: "query" as const,
            status: "active" as const,
            score: 1,
            metadata: {},
          },
        ],
        edges: [],
      },
      events: [],
      findings: [],
      final_answer: null,
    };

    const createResponse: CreateSessionResponse = {
      session_id: "sess_001",
      status: "queued",
      stream_url: "/api/session/sess_001/stream",
      snapshot: createdSnapshot,
    };

    const liveSnapshot = {
      ...createdSnapshot,
      status: "running" as const,
      active_stage: "retrieving_papers",
      budget: {
        ...createdSnapshot.budget,
        spent_usd: 0.012,
        remaining_usd: 0.038,
      },
      graph: {
        nodes: [
          ...createdSnapshot.graph.nodes,
          {
            id: "paper_live",
            label: "Live paper",
            type: "paper" as const,
            status: "active" as const,
            score: 0.8,
            metadata: { year: 2024 },
          },
        ],
        edges: [],
      },
      events: [
        {
          id: "evt_live",
          stage: "retrieval",
          message: "Retrieved 1 paper.",
          created_at: "2026-04-05T14:00:10Z",
        },
      ],
    };

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
    await user.clear(queryBox);
    await user.type(
      queryBox,
      "How should the system handle live session updates?",
    );
    await user.click(
      screen.getByRole("button", { name: /start research session/i }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/session",
        expect.objectContaining({
          method: "POST",
        }),
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
      expect(screen.getByText("sess_001")).toBeInTheDocument();
      expect(screen.getByText(/live paper/i)).toBeInTheDocument();
      expect(screen.getByText(/retrieved 1 paper\./i)).toBeInTheDocument();
      expect(screen.getByText("$0.012")).toBeInTheDocument();
    });
  });
});
