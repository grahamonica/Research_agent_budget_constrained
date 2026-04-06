# Evaluation

## Goal

This project should:

- break a research question into subquestions
- retrieve evidence locally before using GPT-4o
- keep a small amount of structured memory
- stay inside a session budget
- expose its state in a graph-driven UI

The user should be able to see the agent narrow the search space, retain grounded findings, and produce a final answer under constraints.

---

## Simplified Design

Use:

- **one FastAPI backend**
- **one React frontend**
- **one n8n orchestration workflow**
- **one webhook-driven live update flow**

Do not split the system into many services, many route files, or many memory layers unless the implementation actually needs that complexity.

### What stays

- local semantic retrieval
- OpenAI embeddings
- GPT-4o for high-value reasoning only
- a simple cost budget
- structured retained findings
- a visible knowledge graph

### What gets cut

- many backend endpoints
- many artifact types
- separate verification and compression subsystems
- overly detailed graph node types
- production-style module sprawl

---

## Model Strategy

Use:

- **`text-embedding-3-small`** for embeddings
- **`gpt-4o`** for planning and final synthesis

Everything else should stay local:

- vector similarity
- paper filtering
- chunk ranking
- graph updates
- memory storage
- budget tracking

This keeps the project aligned with the goal without overbuilding it.

---

## Runtime Architecture

The system should connect like this:

1. the React frontend starts a research session
2. the FastAPI backend creates the session and returns a `session_id`
3. the FastAPI backend triggers the n8n workflow for that session
4. each n8n workflow step posts progress back into a FastAPI webhook
5. FastAPI publishes those updates to the frontend through a live session stream

This keeps the frontend simple while still making the research process visible in real time.

---

## Minimal Research Loop

The full agent can be reduced to this loop:

1. analyze the query
2. split it into a few subquestions
3. route each subquestion to a small set of categories
4. retrieve top papers and top chunks locally
5. extract a few structured findings
6. retain only the useful findings
7. synthesize the final answer from retained findings

This still demonstrates the core behavior:

**query -> subquestions -> categories -> papers -> findings -> final answer**

---

## Memory Strategy

The memory system should be simple.

### Working state

Keep only the active session state in memory:

- current subquestion
- selected categories
- retrieved papers
- retrieved chunks
- current graph snapshot

### Retained memory

Persist only a small set of `FindingCard` objects.

Suggested fields:

- `id`
- `subquestion`
- `claim`
- `source_ids`
- `confidence`
- `created_at`

### Optional compression

If the session is getting large, older findings can be merged into a lightweight session summary. This should be optional and minimal, not a large multi-level compression architecture.

The point is to show **bounded retained memory**, not to build a full memory framework.

---

## Budget Strategy

Use a budget of `$0.05` max per session.

Track:

- embedding cost
- reasoning cost
- total cost so far
- estimated next-step cost

When near the limit:

- reduce retrieval breadth
- skip optional second-pass work
- avoid repeated synthesis
- return a partial answer if needed

---

## Graph Design

The graph should stay readable.

### Node types

- `query`
- `subquestion`
- `category`
- `paper`
- `finding`
- `final`

### Edge types

- `decomposes_to`
- `routes_to`
- `retrieves`
- `supports`

### Layout

Use a simple left-to-right layout:

**query -> subquestions -> categories / papers -> findings -> final**

Chunk nodes do not need to appear in the default UI. They can stay internal unless needed for debugging.

---

## n8n Workflow

n8n is the required orchestration layer for this project. It should stay lightweight:

1. receive a new session trigger from FastAPI
2. run the research steps in order
3. send progress updates to a FastAPI webhook
4. send a final completion update when synthesis is done

The FastAPI backend remains the system of record for session state, graph state, budget state, and frontend updates.

---

## Frontend

The frontend is a React dashboard.

### Main regions

- **Header**: query title 
- **Graph**: main visual state
- **Side panel**: selected node details and final answer and budget tracker
- **Event log**: simple execution timeline

The frontend should subscribe to a live session stream so the graph, budget, and event log update as research progresses.

For this project, the frontend can stay very small. It does not need a large component tree. A single `App.tsx` file plus a bootstrap file and stylesheet is enough to demonstrate the dashboard clearly.

---

## Project Structure

```text
backend/
  app.py
  pipeline.py
  retrieval.py
  memory.py
  models.py
  budget.py
  webhooks.py
  streaming.py

frontend/
  src/main.tsx
  src/App.tsx
  src/styles.css

n8n/
  research-agent.workflow.jsonc
```
---

## Success Criteria

A user should be able to see:

- the query broken into subquestions
- local retrieval narrowing the search space
- a few retained findings instead of a giant prompt
- visible budget-aware behavior
- a grounded final answer tied to retained evidence
