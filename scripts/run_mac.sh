#!/usr/bin/env bash
set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then
  echo "This is a macOS-only run script. Your OSTYPE is: ${OSTYPE:-unknown}" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PID_DIR="$ROOT_DIR/.claude-ollama-pids"
mkdir -p "$PID_DIR"

OLLAMA_PID_FILE="$PID_DIR/ollama.pid"
MCP_PID_FILE="$PID_DIR/mcp.pid"
OLLAMA_LOG="$PID_DIR/ollama.log"
MCP_LOG="$PID_DIR/mcp.log"

if [[ -f "$OLLAMA_PID_FILE" ]]; then
  OLD_PID="$(cat "$OLLAMA_PID_FILE" 2>/dev/null || true)"
  if [[ -n "${OLD_PID:-}" ]] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
    echo "Ollama already running (pid $OLD_PID)."
  else
    rm -f "$OLLAMA_PID_FILE"
  fi
fi

if [[ ! -f "$OLLAMA_PID_FILE" ]]; then
  echo "Starting Ollama in background..."
  OLLAMA_NUM_CTX=16384 OLLAMA_KEEP_ALIVE=24h nohup ollama serve >"$OLLAMA_LOG" 2>&1 &
  echo $! > "$OLLAMA_PID_FILE"
fi

echo "Waiting for Ollama to be ready..."
READY=0
for _ in {1..60}; do
  if curl -fsS "http://localhost:11434/api/tags" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "$READY" != "1" ]]; then
  echo "Ollama did not become ready. Check log: $OLLAMA_LOG" >&2
  exit 1
fi

if [[ ! -f "$ROOT_DIR/dist/index.js" ]]; then
  echo "dist/index.js not found. Run: npm run build" >&2
  exit 1
fi

if [[ -f "$MCP_PID_FILE" ]]; then
  OLD_PID="$(cat "$MCP_PID_FILE" 2>/dev/null || true)"
  if [[ -n "${OLD_PID:-}" ]] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
    echo "MCP server already running (pid $OLD_PID)."
    exit 0
  else
    rm -f "$MCP_PID_FILE"
  fi
fi

echo "Starting MCP server in background..."
nohup node "$ROOT_DIR/dist/index.js" >"$MCP_LOG" 2>&1 &
echo $! > "$MCP_PID_FILE"

echo "Running."
