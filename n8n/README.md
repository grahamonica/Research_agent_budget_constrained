<!-- Purpose: Document the workflow that posts research progress updates into the FastAPI webhook. -->

# n8n Research Agent Workflow

## What it does

The workflow orchestrates a research session end to end:

1. Receives a session trigger from FastAPI via webhook
2. Posts a "running" status back to FastAPI immediately
3. Calls GPT-4o to decompose the query into subquestions
4. Posts a planning update with the subquestion graph nodes
5. Calls GPT-4o to retrieve relevant papers from an embedded corpus and extract findings
6. Posts a findings update with paper and finding graph nodes
7. Calls GPT-4o to synthesize a final answer from the retained findings
8. Posts a completion update with the final answer

FastAPI stays the source of truth for session state. The workflow only pushes updates into the FastAPI webhook.

---

## Setup

### 1. Install n8n

```bash
npx n8n
# or
npm install -g n8n && n8n start
```

Default n8n runs at `http://localhost:5678`.

### 2. Set environment variables

In n8n → Settings → n8n Environment Variables (or set in your shell before starting n8n):

| Variable | Value |
|---|---|
| `OPEN_AI_API_KEY` | Your OpenAI API key |
| `FASTAPI_BASE_URL` | `http://localhost:8000` (adjust for your deployment) |

If running n8n in Docker and FastAPI on the host, use `http://host.docker.internal:8000` as `FASTAPI_BASE_URL`.

### 3. Import the workflow

1. Open n8n at `http://localhost:5678`
2. Go to **Workflows** → **Import from file**
3. Select `n8n/research-agent.workflow.jsonc`
4. Click **Activate** to enable the workflow

The webhook will be available at:
```
http://localhost:5678/webhook/research-session
```

### 4. Configure FastAPI to point at n8n

Set the environment variable when starting FastAPI:

```bash
N8N_WEBHOOK_URL=http://localhost:5678/webhook/research-session \
FASTAPI_BASE_URL=http://localhost:8000 \
OPEN_AI_API_KEY=sk-... \
uvicorn backend.app:app --reload
```

---

## Fallback behavior

If n8n is unreachable when a session is created, FastAPI will automatically run the research pipeline locally (`backend/pipeline.py`). This uses the same OpenAI API key and the embedded corpus in `backend/retrieval.py`. All SSE updates still reach the frontend — the only difference is that n8n is not involved.

---

## Workflow nodes

| Node | Type | Purpose |
|---|---|---|
| Session Trigger | Webhook | Receives POST from FastAPI |
| Init Session | Code | Extracts params, reads env vars |
| Post Running | HTTP Request | Notifies FastAPI: session is running |
| Build Decompose Request | Code | Builds OpenAI payload for query decomposition |
| Decompose Query | HTTP Request | GPT-4o decomposes query into subquestions |
| Parse Plan | Code | Parses subquestions, builds graph patch |
| Post Planning Update | HTTP Request | Sends planning graph to FastAPI |
| Build Retrieve Request | Code | Builds OpenAI payload with corpus context |
| Retrieve and Extract | HTTP Request | GPT-4o retrieves papers and extracts findings |
| Parse Findings | Code | Parses findings, builds graph patch |
| Post Findings Update | HTTP Request | Sends findings graph to FastAPI |
| Build Synthesize Request | Code | Builds OpenAI payload with findings |
| Synthesize | HTTP Request | GPT-4o synthesizes final answer |
| Parse and Post Completion | Code | Parses answer, posts completion to FastAPI |

---

## Budget

Each session uses approximately:

- Decompose: ~$0.002 (GPT-4o, ~300 input / 200 output tokens)
- Retrieve+Extract: ~$0.008 (GPT-4o, ~1200 input / 600 output tokens)
- Synthesize: ~$0.005 (GPT-4o, ~800 input / 400 output tokens)

Total: ~$0.015 per session, well within the default $0.05 cap.
