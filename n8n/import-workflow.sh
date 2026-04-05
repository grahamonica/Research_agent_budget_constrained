#!/bin/sh
set -eu

mkdir -p /home/node/.n8n

WORKFLOW_SRC="/workflows/research-agent.workflow.jsonc"
WORKFLOW_JSON="/tmp/research-agent.workflow.json"
IMPORT_MARKER="/home/node/.n8n/.research-agent-workflow-imported"

sed -n '/^{/,$p' "$WORKFLOW_SRC" > "$WORKFLOW_JSON"

if [ ! -f "$IMPORT_MARKER" ]; then
  n8n import:workflow --input="$WORKFLOW_JSON"
  touch "$IMPORT_MARKER"
fi

exec n8n start
