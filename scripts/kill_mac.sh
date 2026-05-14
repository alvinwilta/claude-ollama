#!/usr/bin/env bash
set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then
  echo "This is a macOS-only kill script. Your OSTYPE is: ${OSTYPE:-unknown}" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PID_DIR="$ROOT_DIR/.claude-ollama-pids"
OLLAMA_PID_FILE="$PID_DIR/ollama.pid"

kill_pid_file() {
  local label="$1"
  local pid_file="$2"
  if [[ ! -f "$pid_file" ]]; then
    return 0
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -z "${pid:-}" ]]; then
    rm -f "$pid_file"
    return 0
  fi

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    rm -f "$pid_file"
    return 0
  fi

  echo "Stopping $label (pid $pid)..."
  kill "$pid" >/dev/null 2>&1 || true

  for _ in {1..20}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$pid_file"
      return 0
    fi
    sleep 0.25
  done

  echo "$label did not exit, force killing (pid $pid)..."
  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$pid_file"
}

kill_pid_file "Ollama" "$OLLAMA_PID_FILE"

# Best-effort cleanup if pid file was missing/stale.
pkill -f "ollama serve" >/dev/null 2>&1 || true

if [[ -d "$PID_DIR" ]]; then
  rm -rf "$PID_DIR"
fi

echo "Stopped."
