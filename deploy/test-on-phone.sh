#!/bin/sh
# Runs the browser tests against the code on the phone, through Tailscale and HTTPS.
# Usage: deploy/test-on-phone.sh [playwright arguments]
# For the time of the run, a second server on the phone uses a test database and HTTPS port 10000.
# The real server and its database are not touched.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ -f deploy/.env ] && . deploy/.env

host="${S22_HOST:?Set S22_HOST in deploy/.env. See deploy/env.example}"
port="${S22_SSH_PORT:-8022}"
key="${S22_SSH_KEY:-$HOME/.ssh/id_ed25519}"

remote() {
  ssh -p "$port" -i "$key" -o ConnectTimeout=10 -o BatchMode=yes "$host" "$@"
}

public_host="$(remote 'sed -n "s|^export PUBLIC_ORIGIN=\"https://\([^:\"/]*\).*|\1|p" "$HOME/shared-tasks/env"')"
[ -n "$public_host" ] || { echo "The phone has no PUBLIC_ORIGIN. Run deploy/install-phone.sh first."; exit 1; }
origin="https://$public_host:10000"

cleanup() {
  remote 'b="$HOME/shared-tasks"
    tailscale --socket="$HOME/.tailscale/tailscaled.sock" serve --https=10000 off >/dev/null 2>&1 || true
    [ -f "$b/test.pid" ] && kill "$(cat "$b/test.pid")" 2>/dev/null || true
    rm -rf "$b/data-test" "$b/test.pid" "$b/test-server.log" "$b/app/e2e"' || true
}
trap cleanup EXIT

# The seed reads the test accounts from this file. A deploy does not copy it.
remote 'mkdir -p "$HOME/shared-tasks/app/e2e/fixtures" && cat > "$HOME/shared-tasks/app/e2e/fixtures/users.json"' < e2e/fixtures/users.json

remote "TEST_ORIGIN='$origin' sh -s" <<'REMOTE'
set -eu
b="$HOME/shared-tasks"
rm -rf "$b/data-test"
cd "$b/app"
export PORT=5008 HOST=127.0.0.1 DATA_DIR="$b/data-test" WEB_DIR="$b/app/web/dist"
export ST_TEST_RESET=1 MAX_USERS=3 PUBLIC_ORIGIN="$TEST_ORIGIN" NODE_NO_WARNINGS=1
node server/cli.ts seed
setsid node server/main.ts > "$b/test-server.log" 2>&1 &
echo $! > "$b/test.pid"
sleep 2
tailscale --socket="$HOME/.tailscale/tailscaled.sock" serve --bg --https=10000 http://127.0.0.1:5008 >/dev/null
REMOTE

echo "Test server: $origin"
i=0
until curl -fsS -m 5 "$origin/api/health" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 20 ] || { echo "The test server does not answer."; exit 1; }
  sleep 1
done

E2E_BASE_URL="$origin" pnpm exec playwright test --config e2e/playwright.config.ts "$@"
