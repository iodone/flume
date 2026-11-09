#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "flume: node not found; install Node.js ^22.23.4 || ^24.22.1 || >=26.12.1" >&2
  exit 2
fi

ENV_FILE="$ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
  mode="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
  mode="${mode##0}"
  if [[ "$mode" != "600" ]]; then
    echo "flume: $ENV_FILE must have permissions 600" >&2
    exit 2
  fi
  set -a
  source "$ENV_FILE"
  set +a
fi

# Deployment defaults. Values from .env take precedence.
export FLUME_ADAPTERS="${FLUME_ADAPTERS:-github}"
export AGENTINBOX_SOURCE_ID="${AGENTINBOX_SOURCE_ID:-}"
export FLUME_BIND="${FLUME_BIND:-0.0.0.0}"
export FLUME_PORT="${FLUME_PORT:-19420}"
# URL 与 exec 二选一。exec 直接执行任意脚本，完整 prompt 作为最后一个参数。
# Shepherdr 用 hc space <space-id>；脚本参数按空格拆分，不经过 shell。
export FLUME_WAKE_URL="${FLUME_WAKE_URL:-}"
export FLUME_WAKE_EXEC="${FLUME_WAKE_EXEC:-}"
# AgentInbox 中 coordinator 的 agent id；用于读取和确认 inbox。
export FLUME_AGENTINBOX_AGENT_ID="${FLUME_AGENTINBOX_AGENT_ID:-}"
load_secret() {
  local name="$1"
  local service="$2"
  local current="$3"
  if [[ -n "$current" ]]; then
    return
  fi
  if ! command -v security >/dev/null 2>&1; then
    echo "flume: $name is not set; set it in the environment" >&2
    exit 2
  fi
  local value
  if ! value="$(security find-generic-password -a flume -s "$service" -w)"; then
    echo "flume: $name is not set and keychain lookup failed" >&2
    exit 2
  fi
  export "$name=$value"
}

if [[ ",$FLUME_ADAPTERS," == *",gitlab,"* ]]; then
  load_secret FLUME_GITLAB_TOKEN flume-gitlab-webhook "${FLUME_GITLAB_TOKEN:-}"
fi

if [[ ",$FLUME_ADAPTERS," == *",github,"* ]]; then
  load_secret FLUME_GITHUB_SECRET flume-github-webhook "${FLUME_GITHUB_SECRET:-}"
fi

if [[ ! -d "$ROOT/node_modules" ]]; then
  echo "flume: installing dependencies..." >&2
  npm --prefix "$ROOT" install --silent
fi

if [[ ! -f "$ROOT/dist/src/cli.js" ]]; then
  echo "flume: building..." >&2
  npm --prefix "$ROOT" run build --silent
fi

unset FLUME_ENV_FILE
exec node "$ROOT/dist/src/cli.js" start
