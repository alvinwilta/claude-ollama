#!/usr/bin/env bash
set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then
  echo "This is a macOS-only setup script. Your OSTYPE is: ${OSTYPE:-unknown}" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "macOS setup for claude-ollama"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install it from https://brew.sh/ then re-run this script." >&2
  exit 1
fi

if ! command -v ollama >/dev/null 2>&1; then
  echo "Installing Ollama with Homebrew..."
  brew install ollama
else
  echo "Ollama already installed: $(command -v ollama)"
fi

ENV_FILE="$ROOT_DIR/.env"
ENV_CONTENT="$(cat <<'EOF'
OLLAMA_DEFAULT_MODEL=qwen2.5-coder:14b
OLLAMA_DEFAULT_MODEL_EMBED=nomic-embed-text
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_TIMEOUT=300000
EOF
)"

if [[ -f "$ENV_FILE" ]]; then
  BACKUP="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
  echo "Backing up existing .env to $BACKUP"
  cp "$ENV_FILE" "$BACKUP"
fi

echo "Writing .env"
printf "%s\n" "$ENV_CONTENT" > "$ENV_FILE"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js (>=18) then re-run." >&2
  exit 1
fi

echo "Installing dependencies..."
if [[ -f "$ROOT_DIR/package-lock.json" ]]; then
  npm ci
else
  npm install
fi

echo "Building project..."
npm run build

echo "Starting Ollama (briefly) to pull model..."
PID_DIR="$ROOT_DIR/.claude-ollama-pids"
mkdir -p "$PID_DIR"
OLLAMA_LOG="$PID_DIR/ollama.setup.log"

set +e
OLLAMA_NUM_CTX=16384 OLLAMA_KEEP_ALIVE=24h nohup ollama serve >"$OLLAMA_LOG" 2>&1 &
OLLAMA_PID=$!
set -e

cleanup() {
  if kill -0 "$OLLAMA_PID" >/dev/null 2>&1; then
    kill "$OLLAMA_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

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

MODEL="qwen2.5-coder:14b"
PULL_TIMEOUT_SECONDS="${OLLAMA_PULL_TIMEOUT_SECONDS:-3600}"
echo "Pulling model: $MODEL (timeout: ${PULL_TIMEOUT_SECONDS}s)"

set +e
perl -e 'alarm shift; exec @ARGV' "$PULL_TIMEOUT_SECONDS" ollama pull "$MODEL"
PULL_EXIT=$?
set -e

if [[ "$PULL_EXIT" -ne 0 ]]; then
  echo "Model pull failed (exit $PULL_EXIT)." >&2
  echo "If this was a timeout, please check your network connection and try again." >&2
  exit "$PULL_EXIT"
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude CLI not found ('claude'). Install it, then run:" >&2
  echo "  claude mcp add --transport stdio claude-ollama -- node \"$ROOT_DIR/dist/index.js\"" >&2
  exit 1
fi

ABS_DIST="$ROOT_DIR/dist/index.js"
echo "Attaching MCP to Claude CLI..."
set +e
claude mcp add --transport stdio claude-ollama -- node "$ABS_DIST"
ADD_EXIT=$?
set -e

if [[ "$ADD_EXIT" -ne 0 ]]; then
  echo "Could not add MCP (exit $ADD_EXIT). It may already exist." >&2
  echo "Try listing/removing then re-adding if needed." >&2
fi

echo "Done."
