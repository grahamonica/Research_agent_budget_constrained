# Evaluation

## Goal

This project:

- break a research question into subquestions
- retrieve evidence locally before using GPT-4o
- keep a small amount of structured memory
- stay inside a session budget
- expose its state in a graph-driven UI

The user can see the agent narrow the search space, retain grounded findings, and produce a final answer under constraints.

---

## Design

- **one FastAPI backend**
- **one React frontend**
- **one n8n orchestration workflow**
- **one webhook-driven live update flow**


This includes
- local semantic retrieval
- OpenAI embeddings
- GPT-4o for high-value reasoning only
- a simple cost budget
- structured retained findings
- a visible knowledge graph


## Model Strategy

- **`text-embedding-3-small`** for embeddings
- **`gpt-4o`** for planning and final synthesis

Everything else stays local:

- vector similarity
- paper filtering
- chunk ranking
- graph updates
- memory storage
- budget tracking

---

## Runtime Architecture

The system connects like this:

1. the React frontend starts a research session
2. the FastAPI backend creates the session and returns a `session_id`
3. the FastAPI backend triggers the n8n workflow for that session
4. each n8n workflow step posts progress back into a FastAPI webhook
5. FastAPI publishes those updates to the frontend through a live session stream

This keeps the frontend simple while still making the research process visible in real time.

---

## Research Loop

The full agent can be reduced to this loop:

1. analyze the query
2. split it into a few subquestions
3. route each subquestion to a small set of categories
4. retrieve top papers and top chunks locally
5. extract a few structured findings
6. retain only the useful findings
7. synthesize the final answer from retained findings

This demonstrates the core behavior:

**query -> subquestions -> categories -> papers -> findings -> final answer**

---

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

The graph expands radialy, with the core question at the center, surrounding by a ring of subquestions, surrounded by a ring of papers, surrounded my layers of findings.

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

The current UI uses a radial layout with the query near the center and downstream evidence arranged outward by type.

Chunk nodes stay internal unless needed for debugging.

---

## n8n Workflow

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

The frontend subscribes to a live session stream so the graph, budget, and event log update as research progresses.

For this project, frontend does not need a large component tree. A single `App.tsx` file plus a bootstrap file and stylesheet is enough to demonstrate the dashboard clearly.

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

- the query broken into subquestions
- local retrieval narrowing the search space
- a few retained findings instead of a giant prompt
- visible budget-aware behavior
- a grounded final answer tied to retained evidence
