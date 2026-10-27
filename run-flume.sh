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
# 唤醒目标使用的 coordinator agent 名。
export FLUME_HERDR_WAKE_AGENT="${FLUME_HERDR_WAKE_AGENT:-}"
# AgentInbox 中 coordinator 的 agent id；用于读取和确认 inbox。
export FLUME_AGENTINBOX_AGENT_ID="${FLUME_AGENTINBOX_AGENT_ID:-}"
# agent 侧的 event intake 策略；flume 只把路径传给唤醒 prompt，不执行它。
# 没有内置默认值。复制 templates/workflow-event-intake/ 并把这里指向你的 SKILL.md。
export HERDR_BIN_PATH="${HERDR_BIN_PATH:-herdr}"
export FLUME_HERDR_WAKE_TIMEOUT="${FLUME_HERDR_WAKE_TIMEOUT:-10}"

if [[ -z "${FLUME_AGENTINBOX_INTAKE_SKILL:-}" ]]; then
  echo "flume: FLUME_AGENTINBOX_INTAKE_SKILL is required; copy templates/workflow-event-intake/ and point it at your SKILL.md" >&2
  exit 2
fi

if [[ ! -f "$FLUME_AGENTINBOX_INTAKE_SKILL" ]]; then
  echo "flume: intake skill not found at $FLUME_AGENTINBOX_INTAKE_SKILL" >&2
  exit 2
fi

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
