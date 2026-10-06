#!/bin/sh
# First-time setup of Shared Tasks on the phone. Run it one time, after the first deploy/deploy.sh.
# Usage: deploy/install-phone.sh <public origin>
# Example: deploy/install-phone.sh https://s22.example.ts.net:8443
# It writes the settings file, adds the server to the start script of the phone, starts it,
# and tells `tailscale serve` to put HTTPS on the port of the public origin.
set -eu

origin="${1:-}"
case "$origin" in
  https://*:*) ;;
  *) echo "Usage: deploy/install-phone.sh https://<host>:<port>"; exit 2 ;;
esac
https_port="${origin##*:}"

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ -f deploy/.env ] && . deploy/.env

host="${S22_HOST:?Set S22_HOST in deploy/.env. See deploy/env.example}"
port="${S22_SSH_PORT:-8022}"
key="${S22_SSH_KEY:-$HOME/.ssh/id_ed25519}"

ssh -p "$port" -i "$key" -o ConnectTimeout=10 -o BatchMode=yes "$host" \
  "ORIGIN='$origin' HTTPS_PORT='$https_port' sh -s" <<'EOF'
set -eu
base="$HOME/shared-tasks"
[ -f "$base/start.sh" ] || { echo "Run deploy/deploy.sh first."; exit 1; }

# The settings of this phone.
if [ ! -f "$base/env" ]; then
  printf 'export PUBLIC_ORIGIN="%s"\n' "$ORIGIN" > "$base/env"
  chmod 600 "$base/env"
fi

# Start with the other services when the phone starts.
all="$HOME/server/start-all.sh"
if ! grep -q 'shared-tasks/start.sh' "$all"; then
  printf '%s\n' 'setsid "$k" tasks "$HOME/shared-tasks/start.sh" >/dev/null 2>&1 &' >> "$all"
fi

# Start it now. keep-running.sh does not start a second copy.
setsid "$HOME/server/keep-running.sh" tasks "$base/start.sh" >/dev/null 2>&1 &
sleep 3

ts="tailscale --socket=$HOME/.tailscale/tailscaled.sock"
$ts serve --bg --https="$HTTPS_PORT" http://127.0.0.1:5007
$ts serve status
EOF
