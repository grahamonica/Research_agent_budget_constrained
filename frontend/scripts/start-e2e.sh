#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)

cleanup() {
  kill "${BACKEND_PID:-}" "${FRONTEND_PID:-}" 2>/dev/null || true
  wait "${BACKEND_PID:-}" "${FRONTEND_PID:-}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

cd "$ROOT_DIR"
PYTHONUNBUFFERED=1 \
PYTHONPATH="$ROOT_DIR" \
RESEARCH_AGENT_TEST_MODE=1 \
python3 -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 &
BACKEND_PID=$!

cd "$ROOT_DIR/frontend"
VITE_API_PROXY_TARGET=http://127.0.0.1:8000 \
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort &
FRONTEND_PID=$!

wait "$BACKEND_PID" "$FRONTEND_PID"
