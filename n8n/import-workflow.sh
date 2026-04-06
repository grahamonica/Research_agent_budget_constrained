#!/bin/sh
set -eu

mkdir -p /home/node/.n8n

WORKFLOW_SRC="/workflows/research-agent.workflow.jsonc"
WORKFLOW_JSON="/tmp/research-agent.workflow.json"
IMPORT_CHECKSUM_FILE="/home/node/.n8n/.research-agent-workflow.cksum"

sed -n '/^{/,$p' "$WORKFLOW_SRC" > "$WORKFLOW_JSON"

CURRENT_CHECKSUM="$(cksum "$WORKFLOW_JSON" | awk '{print $1 ":" $2}')"
PREVIOUS_CHECKSUM=""
if [ -f "$IMPORT_CHECKSUM_FILE" ]; then
  PREVIOUS_CHECKSUM="$(cat "$IMPORT_CHECKSUM_FILE")"
fi

if [ "$CURRENT_CHECKSUM" != "$PREVIOUS_CHECKSUM" ]; then
  n8n import:workflow --input="$WORKFLOW_JSON"
  printf '%s' "$CURRENT_CHECKSUM" > "$IMPORT_CHECKSUM_FILE"
fi

n8n update:workflow --id="research-agent-workflow-001" --active=true

exec n8n start
