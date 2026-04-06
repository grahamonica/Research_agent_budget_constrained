<!-- Purpose: Document the n8n workflow that owns the research stages and reports progress into FastAPI. -->

# n8n Research Agent Workflow

## What it does

The workflow orchestrates a research session end to end:

1. FastAPI creates the session and POSTs it to `n8n`
2. `n8n` initializes workflow state
3. `n8n` runs the research stages as workflow nodes:
   - decompose
   - retrieve
   - prune
   - extract
   - expand
   - synthesize
4. each stage pushes updates into FastAPI at `/api/webhook/session-update`
5. FastAPI stores the session snapshot and streams it to the frontend

FastAPI is no longer responsible for running the research logic. It only owns:

- `POST /api/session`
- `GET /api/session/{id}`
- `GET /api/session/{id}/stream`
- `POST /api/webhook/session-update`

The shared stage runtime lives in:

- `n8n/runtime/research_runtime.js`
- `n8n/runtime/research_stage_runner.js`

The workflow definition lives in:

- `n8n/research-agent.workflow.jsonc`

## Setup

### 1. Install n8n

```bash
npx n8n
# or
npm install -g n8n && n8n start
```

Default n8n runs at `http://localhost:5678`.

### 2. Set environment variables

`n8n` needs:

| Variable | Value |
|---|---|
| `OPEN_AI_API_KEY` | your OpenAI API key |
| `RESEARCH_AGENT_TEST_MODE` | optional; `1` / `true` / `yes` for deterministic local test mode |

### 3. Import the workflow

1. Open n8n at `http://localhost:5678`
2. Go to **Workflows** → **Import from file**
3. Select `n8n/research-agent.workflow.jsonc`
4. Click **Activate**

The webhook will be available at:

```text
http://localhost:5678/webhook/research-session
```

### 4. Point FastAPI at n8n

Set `N8N_WEBHOOK_URL` for the backend:

```bash
N8N_WEBHOOK_URL=http://localhost:5678/webhook/research-session \
uvicorn backend.app:app --reload
```

FastAPI now includes its own webhook callback URL in the trigger payload, so `n8n` does not need a separate `FASTAPI_BASE_URL` setting.

## Workflow nodes

| Node | Type | Purpose |
|---|---|---|
| Session Trigger | Webhook | Receives the session payload from FastAPI |
| Initialize Session State | Code | Builds the workflow state object passed between nodes |
| Decompose Query | Execute Command | Runs the decomposition stage |
| Retrieve Main Papers | Execute Command | Runs retrieval for initial subquestions |
| Prune Main Papers | Execute Command | Applies the current pruning rules to initial retrieval branches |
| Extract Main Findings | Execute Command | Extracts retained findings for initial subquestions |
| Plan Expansion | Execute Command | Decides whether to expand and creates follow-up subquestions |
| Retrieve Expansion Papers | Execute Command | Runs retrieval for expansion subquestions |
| Prune Expansion Papers | Execute Command | Applies pruning to expansion retrieval branches |
| Extract Expansion Findings | Execute Command | Extracts retained findings for expansion subquestions |
| Synthesize Final Answer | Execute Command | Produces the final answer and posts completion |

The small parse nodes between the command nodes only decode stdout back into workflow state for the next step.
