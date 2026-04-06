# Frontend / Backend Contract

## Overview

The system uses:

- a **React frontend**
- a **thin FastAPI backend**
- a **required n8n research workflow**
- a **webhook for session updates**
- a **live stream from FastAPI to the frontend**

The React app should never talk directly to workflow internals. It only talks to FastAPI.

FastAPI is responsible for:

- creating sessions
- triggering the n8n workflow
- storing session state
- accepting workflow updates through a webhook
- pushing live updates to the React client

n8n is responsible for:

- decomposition
- retrieval
- pruning
- extraction
- expansion
- synthesis

For this project, a single `App.tsx` can own request submission, SSE subscription, session state, and dashboard rendering.

---

## Connection Model

The runtime flow is:

1. React sends a new query to FastAPI
2. FastAPI creates a session and returns a `session_id`
3. React opens a live stream for that session
4. the n8n workflow runs the research stages and sends progress updates into a FastAPI webhook
5. FastAPI updates the stored session snapshot
6. FastAPI pushes the new session state to the React frontend

This gives the UI live updates without making the frontend responsible for orchestration.

---

## Transport

### Frontend to FastAPI

- Protocol: `HTTP`
- Format: `application/json`
- Base path: `/api`

### FastAPI live updates to React

- Protocol: `HTTP`
- Stream type: `text/event-stream`
- Recommended implementation: `Server-Sent Events (SSE)`

### Workflow to FastAPI

- Protocol: `HTTP`
- Format: `application/json`
- Endpoint type: webhook

---

## Public FastAPI Endpoints

### `POST /api/session`

Creates a new research session.

FastAPI should create the session record and then trigger the n8n workflow.

#### Request body

```json
{
  "query": "What are the main limitations of retrieval-augmented generation systems?",
  "budget_cap_usd": 0.05,
  "max_subquestions": 4,
  "max_papers_per_subquestion": 3,
  "max_chunks_per_paper": 5
}
```

#### Parameters

- `query: string`
  The user research question.
- `budget_cap_usd: number`
  Maximum cost allowed for the session.
- `max_subquestions: number`
  Maximum number of planned subquestions.
- `max_papers_per_subquestion: number`
  Maximum papers retrieved for one subquestion.
- `max_chunks_per_paper: number`
  Maximum chunks considered from one paper.

#### Response body

```json
{
  "session_id": "sess_001",
  "status": "queued",
  "stream_url": "/api/session/sess_001/stream",
  "snapshot": {
    "session_id": "sess_001",
    "query": "What are the main limitations of retrieval-augmented generation systems?",
    "status": "queued",
    "active_stage": "created",
    "budget": {
      "cap_usd": 0.05,
      "spent_usd": 0.0,
      "remaining_usd": 0.05,
      "estimated_next_step_usd": 0.0
    },
    "subquestions": [],
    "graph": {
      "nodes": [],
      "edges": []
    },
    "findings": [],
    "final_answer": null,
    "events": [],
    "created_at": "2026-04-05T14:00:00Z",
    "updated_at": "2026-04-05T14:00:00Z"
  }
}
```

### `GET /api/session/{session_id}`

Returns the latest full snapshot for a session.

#### Path parameters

- `session_id: string`

#### Response body

Returns a `SessionSnapshot`.

### `GET /api/session/{session_id}/stream`

Streams live session updates to the React frontend using SSE.

#### Path parameters

- `session_id: string`

#### Event payload

Each SSE message should contain a `SessionUpdateEvent`.

```json
{
  "type": "session_updated",
  "session_id": "sess_001",
  "snapshot": {
    "session_id": "sess_001",
    "query": "What are the main limitations of retrieval-augmented generation systems?",
    "status": "running",
    "active_stage": "retrieving_papers",
    "budget": {
      "cap_usd": 0.05,
      "spent_usd": 0.012,
      "remaining_usd": 0.038,
      "estimated_next_step_usd": 0.004
    },
    "subquestions": [],
    "graph": {
      "nodes": [],
      "edges": []
    },
    "findings": [],
    "final_answer": null,
    "events": [],
    "created_at": "2026-04-05T14:00:00Z",
    "updated_at": "2026-04-05T14:00:10Z"
  }
}
```

---

## Internal Webhook Endpoint

### `POST /api/webhook/session-update`

This endpoint is for n8n workflow steps to push updates into FastAPI.

The frontend does not call this endpoint.

#### Request body

```json
{
  "session_id": "sess_001",
  "status": "running",
  "active_stage": "retrieving_papers",
  "event": {
    "id": "evt_3",
    "stage": "retrieval",
    "message": "Retrieved 3 papers for subquestion 1.",
    "created_at": "2026-04-05T14:00:10Z"
  },
  "graph_patch": {
    "nodes": [],
    "edges": []
  },
  "new_findings": [],
  "budget": {
    "cap_usd": 0.05,
    "spent_usd": 0.012,
    "remaining_usd": 0.038,
    "estimated_next_step_usd": 0.004
  },
  "final_answer": null
}
```

#### Parameters

- `session_id: string`
  The session to update.
- `status: "queued" | "running" | "completed" | "partial" | "failed"`
  Updated session status.
- `active_stage: string`
  Current stage name.
- `event: SessionEvent | null`
  Timeline event to append.
- `graph_patch: GraphPatch | null`
  Nodes and edges to add or update.
- `new_findings: FindingCard[]`
  Newly retained findings from the current step.
- `budget: BudgetState | null`
  Latest budget values.
- `final_answer: FinalAnswer | null`
  Final answer when the session finishes.

---

## Shared Objects

### `CreateSessionResponse`

- `session_id: string`
- `status: string`
- `stream_url: string`
- `snapshot: SessionSnapshot`

### `SessionSnapshot`

- `session_id: string`
- `query: string`
- `status: "queued" | "running" | "completed" | "partial" | "failed"`
- `active_stage: string`
- `budget: BudgetState`
- `subquestions: Subquestion[]`
- `graph: GraphSnapshot`
- `findings: FindingCard[]`
- `final_answer: FinalAnswer | null`

The final answer is delivered in `final_answer`. It should not be represented as a graph node.
- `events: SessionEvent[]`
- `created_at: string`
- `updated_at: string`

### `BudgetState`

- `cap_usd: number`
- `spent_usd: number`
- `remaining_usd: number`
- `estimated_next_step_usd: number`

### `Subquestion`

- `id: string`
- `text: string`
- `status: "pending" | "running" | "completed" | "partial"`

### `GraphSnapshot`

- `nodes: GraphNode[]`
- `edges: GraphEdge[]`

### `GraphPatch`

- `nodes: GraphNode[]`
- `edges: GraphEdge[]`

### `GraphNode`

- `id: string`
- `label: string`
- `type: "query" | "subquestion" | "category" | "paper" | "finding" | "final"`
- `status: "idle" | "active" | "completed" | "discarded"`
- `score: number | null`
- `metadata: object`

### `GraphEdge`

- `id: string`
- `source: string`
- `target: string`
- `type: "decomposes_to" | "routes_to" | "retrieves" | "supports"`
- `weight: number | null`

### `FindingCard`

- `id: string`
- `subquestion_id: string`
- `claim: string`
- `source_ids: string[]`
- `confidence: number`
- `created_at: string`

### `FinalAnswer`

- `text: string`
- `citations: string[]`
- `uncertainty: string`

### `SessionEvent`

- `id: string`
- `stage: string`
- `message: string`
- `created_at: string`

### `SessionUpdateEvent`

- `type: "session_updated" | "session_completed" | "session_failed"`
- `session_id: string`
- `snapshot: SessionSnapshot`

---

## React State Shape

The minimal frontend only needs one main React container.

### `App`

Consumes:

- `session: SessionSnapshot | null`
- `connection_status: "idle" | "connecting" | "live" | "closed"`
- `selected_node_id: string | null`

Within `App.tsx`, the dashboard can render:

- a query form
- a graph section
- a side panel
- an event log

---

## Recommended Frontend Flow

1. user submits a query from React
2. React calls `POST /api/session`
3. React saves `session_id` and `stream_url`
4. React opens `EventSource(stream_url)`
5. React replaces local session state whenever a new `SessionUpdateEvent` arrives
6. React stops listening when session status becomes `completed`, `partial`, or `failed`

---

## Implementation Note

The webhook is for n8n-to-backend communication.

The live stream is for backend-to-frontend communication.

That split is important:

- webhooks are good for n8n-to-server updates
- SSE is simple for one-way live UI updates
- FastAPI stays the single source of truth between n8n and the React app
