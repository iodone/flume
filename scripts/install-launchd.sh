#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-launchd.sh [--no-start]

Builds flume into ~/Applications/flume, writes the flume and AgentInbox
LaunchAgents, and starts both services. Use --no-start to prepare a controlled
cutover while an existing process still owns port 19420 or the AgentInbox socket.
EOF
}

start_services=true
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ "${1:-}" == "--no-start" ]]; then
  start_services=false
elif [[ $# -gt 0 ]]; then
  usage >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install-launchd: macOS is required" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
install_dir="${FLUME_INSTALL_DIR:-$HOME/Applications/flume}"
config_dir="${FLUME_CONFIG_DIR:-$HOME/.config/flume}"
log_dir="${FLUME_LOG_DIR:-$HOME/Library/Logs/flume}"
launch_agent_dir="$HOME/Library/LaunchAgents"
env_file="$config_dir/flume.env"
source_id="src_kdafkw75ry7k"
bind_address="0.0.0.0"
port="19420"
wake_url="http://127.0.0.1:18924/wake"
node_bin="${FLUME_NODE_BIN:-$(command -v node || true)}"

if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  echo "install-launchd: node is not available; set FLUME_NODE_BIN" >&2
  exit 1
fi
for command_name in npm security rsync plutil; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "install-launchd: missing required command: $command_name" >&2
    exit 1
  fi
done

umask 077
mkdir -p "$install_dir" "$config_dir" "$log_dir" "$launch_agent_dir"
chmod 700 "$config_dir" "$log_dir"
touch "$log_dir/flume.log" "$log_dir/flume.err.log"
touch "$log_dir/agentinbox.log" "$log_dir/agentinbox.err.log"

if [[ "$repo_root" != "$install_dir" ]]; then
  rsync -a --delete \
    --exclude='.git/' \
    --exclude='node_modules/' \
    --exclude='dist/' \
    "$repo_root/" "$install_dir/"
fi

(
  cd "$install_dir"
  npm ci --silent
  npm run build --silent
)

# Keep the Keychain as the operator-facing source of truth, but give launchd a
# 600 file that flume reads internally. The token never enters argv or process.env.
if token="$(security find-generic-password -a flume -s flume-gitlab-webhook -w)"; then
  if [[ -z "$token" ]]; then
    echo "install-launchd: Keychain item is empty" >&2
    exit 1
  fi
  token_tmp="$env_file.tmp.$$"
  printf 'FLUME_GITLAB_TOKEN=%s\n' "$token" >"$token_tmp"
  chmod 600 "$token_tmp"
  mv "$token_tmp" "$env_file"
elif [[ ! -s "$env_file" ]]; then
  cat >&2 <<EOF
install-launchd: no Keychain item named flume-gitlab-webhook and no $env_file.
Create the item with:
  security add-generic-password -U -a flume -s flume-gitlab-webhook -w
EOF
  exit 1
fi
chmod 600 "$env_file"

flume_plist="$launch_agent_dir/com.xiaomi.flume.gitlab.plist"
agentinbox_plist="$launch_agent_dir/com.xiaomi.flume.agentinbox.plist"

cat >"$flume_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.xiaomi.flume.gitlab</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$install_dir/dist/src/cli.js</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$install_dir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>AGENTINBOX_SOURCE_ID</key>
    <string>$source_id</string>
    <key>FLUME_BIND</key>
    <string>$bind_address</string>
    <key>FLUME_PORT</key>
    <string>$port</string>
    <key>FLUME_HERDR_WAKE_URL</key>
    <string>$wake_url</string>
    <key>FLUME_ENV_FILE</key>
    <string>$env_file</string>
    <key>FLUME_AGENTINBOX_AUTOSTART</key>
    <string>0</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$log_dir/flume.log</string>
  <key>StandardErrorPath</key>
  <string>$log_dir/flume.err.log</string>
</dict>
</plist>
EOF

agentinbox_cli="$install_dir/node_modules/@holon-run/agentinbox/dist/src/cli.js"
cat >"$agentinbox_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.xiaomi.flume.agentinbox</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$agentinbox_cli</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$install_dir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>AGENTINBOX_HOME</key>
    <string>$HOME/.agentinbox</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$log_dir/agentinbox.log</string>
  <key>StandardErrorPath</key>
  <string>$log_dir/agentinbox.err.log</string>
</dict>
</plist>
EOF

plutil -lint "$flume_plist" >/dev/null
plutil -lint "$agentinbox_plist" >/dev/null
chmod 600 "$flume_plist" "$agentinbox_plist"

echo "install-launchd: installed $install_dir"
echo "install-launchd: plists $flume_plist $agentinbox_plist"

if [[ "$start_services" != true ]]; then
  echo "install-launchd: services not started (--no-start)"
  exit 0
fi

domain="gui/$(id -u)"

bootout() {
  local target="$1"
  launchctl bootout "$target" 2>/dev/null || true
  for _ in {1..50}; do
    if ! launchctl print "$target" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  echo "install-launchd: could not unload $target" >&2
  return 1
}

bootout "$domain/com.xiaomi.flume.gitlab"
bootout "$domain/com.xiaomi.flume.agentinbox"
launchctl bootstrap "$domain" "$agentinbox_plist"

daemon_ready=false
for _ in {1..100}; do
  if "$node_bin" "$agentinbox_cli" status >/dev/null 2>&1; then
    daemon_ready=true
    break
  fi
  sleep 0.1
done
if [[ "$daemon_ready" != true ]]; then
  echo "install-launchd: AgentInbox did not become ready; check $log_dir/agentinbox.err.log" >&2
  exit 1
fi

launchctl bootstrap "$domain" "$flume_plist"
flume_ready=false
for _ in {1..100}; do
  if curl -fsS --max-time 1 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    flume_ready=true
    break
  fi
  sleep 0.1
done
if [[ "$flume_ready" != true ]]; then
  echo "install-launchd: flume did not become healthy; check $log_dir/flume.err.log" >&2
  exit 1
fi

echo "install-launchd: both services are running"
