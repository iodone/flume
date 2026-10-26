#!/usr/bin/env bash
set -euo pipefail

label="${1:-com.xiaomi.flume.gitlab}"
domain="gui/$(id -u)"

python3 - "$label" "$domain" "$HOME/Library/LaunchAgents" <<'PY'
import glob
import os
import subprocess
import sys

label, domain, plist_dir = sys.argv[1:4]
token = subprocess.check_output(
    ["security", "find-generic-password", "-a", "flume",
     "-s", "flume-gitlab-webhook", "-w"],
    text=True,
).strip()
if not token:
    raise SystemExit("secret-exposure: Keychain token is empty")

def output(argv):
    return subprocess.run(argv, text=True, capture_output=True, check=False).stdout

service = output(["launchctl", "print", f"{domain}/{label}"])
pid = ""
for line in service.splitlines():
    if line.strip().startswith("pid = "):
        pid = line.split("=", 1)[1].strip()
        break
if not pid:
    raise SystemExit("secret-exposure: LaunchAgent has no running pid")

plists = "".join(
    open(path, encoding="utf-8").read()
    for path in glob.glob(os.path.join(plist_dir, "*.plist"))
)
commands = output(["ps", "-axo", "command="])
process = output(["ps", "-p", pid, "-o", "command="])
environment = output(["ps", "eww", "-p", pid])
environments = output(["ps", "eww", "-axo", "command="])

checks = {
    "launchctl_env": token in service,
    "launch_plists": token in plists,
    "process_command": token in process,
    "process_environment": token in environment,
    "all_process_commands": token in commands,
    "all_process_environments": token in environments,
}
for name, exposed in checks.items():
    print(f"{name}={'EXPOSED' if exposed else 'clean'}")

if any(checks.values()):
    raise SystemExit(1)
PY
