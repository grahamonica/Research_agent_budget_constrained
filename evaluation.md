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

- **one small backend**
- **one n8n workflow**
- **one frontend dashboard page**

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

Use a budget of $0.05 max per session**

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

1. receive query from webhook
2. initialize session and budget
3. call backend to plan subquestions
4. loop through subquestions
5. call backend to retrieve and extract findings
6. update graph and timeline state
7. call backend to synthesize final answer
8. return final session payload

---

## Frontend

The frontend contains a dashboard view.

### Main regions

- **Header**: query title 
- **Graph**: main visual state
- **Side panel**: selected node details and final answer and budget tracker
- **Event log**: simple execution timeline

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

frontend/
  src/app/layout.tsx
  src/app/page.tsx
  src/app/globals.css
  src/components/ResearchDashboard.tsx
  src/components/KnowledgeGraph.tsx
  src/components/SessionPanel.tsx
  src/components/EventLog.tsx
  src/lib/types.ts

n8n/
  research-agent.workflow.jsonc

data/
  corpus/
  sessions/
```
---

## Success Criteria

A user should be able to see:

- the query broken into subquestions
- local retrieval narrowing the search space
- a few retained findings instead of a giant prompt
- visible budget-aware behavior
- a grounded final answer tied to retained evidence
