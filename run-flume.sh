#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SYSTEM_WEAVER_ROOT="$(cd "$ROOT/../.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "flume: node not found; install Node.js ^22.23.4 || ^24.22.1 || >=26.12.1" >&2
  exit 2
fi

# Deployment defaults. Override any of these with environment variables.
export AGENTINBOX_SOURCE_ID="${AGENTINBOX_SOURCE_ID:-src_kdafkw75ry7k}"
export FLUME_BIND="${FLUME_BIND:-0.0.0.0}"
export FLUME_PORT="${FLUME_PORT:-19420}"
# herdr-projects workspace 的 coordinator agent；不是 workspace 名。
export FLUME_HERDR_WAKE_AGENT="${FLUME_HERDR_WAKE_AGENT-sw-coordinator}"
# AgentInbox 中 coordinator 的 agent id；用于读取和确认 inbox。
export FLUME_AGENTINBOX_AGENT_ID="${FLUME_AGENTINBOX_AGENT_ID:-herdr-main}"
# agent 侧的 event intake 策略；flume 只把路径传给唤醒 prompt，不执行它。
# 优先使用部署实例，缺失时回退到仓库自带模板。
DEPLOYED_INTAKE_SKILL="$SYSTEM_WEAVER_ROOT/.agents/skills/workflow-gitlab-event-intake/SKILL.md"
TEMPLATE_INTAKE_SKILL="$ROOT/templates/workflow-event-intake/SKILL.md"
if [[ ! -f "$DEPLOYED_INTAKE_SKILL" && -f "$TEMPLATE_INTAKE_SKILL" ]]; then
  DEPLOYED_INTAKE_SKILL="$TEMPLATE_INTAKE_SKILL"
fi
export FLUME_AGENTINBOX_INTAKE_SKILL="${FLUME_AGENTINBOX_INTAKE_SKILL:-$DEPLOYED_INTAKE_SKILL}"
export HERDR_BIN_PATH="${HERDR_BIN_PATH:-/Users/mi/.local/bin/herdr}"
export FLUME_HERDR_WAKE_TIMEOUT="${FLUME_HERDR_WAKE_TIMEOUT:-10}"

if [[ ! -f "$FLUME_AGENTINBOX_INTAKE_SKILL" ]]; then
  echo "flume: intake skill not found at $FLUME_AGENTINBOX_INTAKE_SKILL; using generic fallback" >&2
fi

if [[ -z "${FLUME_GITLAB_TOKEN:-}" ]]; then
  if ! command -v security >/dev/null 2>&1; then
    echo "flume: FLUME_GITLAB_TOKEN is not set; set it in the environment" >&2
    exit 2
  fi
  if ! FLUME_GITLAB_TOKEN="$(security find-generic-password -a flume -s flume-gitlab-webhook -w)"; then
    echo "flume: FLUME_GITLAB_TOKEN is not set and keychain lookup failed" >&2
    exit 2
  fi
  export FLUME_GITLAB_TOKEN
fi

if [[ ! -d "$ROOT/node_modules" ]]; then
  echo "flume: installing dependencies..." >&2
  npm --prefix "$ROOT" install --silent
fi

if [[ ! -f "$ROOT/dist/src/cli.js" ]]; then
  echo "flume: building..." >&2
  npm --prefix "$ROOT" run build --silent
fi

exec node "$ROOT/dist/src/cli.js" start
