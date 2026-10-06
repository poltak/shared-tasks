#!/bin/sh
# Builds the client on this Mac, copies the app to the phone through SSH, and restarts the server there.
# Usage: deploy/deploy.sh
# The first run on a phone also needs deploy/install-phone.sh.
# Settings come from deploy/.env (not in the repository) or from the environment:
#   S22_HOST      address of the phone          (no default)
#   S22_SSH_PORT  port of the SSH server        (default 8022)
#   S22_SSH_KEY   private key for the phone     (default ~/.ssh/id_ed25519)
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

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  pnpm build
fi
[ -f web/dist/index.html ] || { echo "web/dist is missing"; exit 1; }

# The phone has no rsync, so one tar stream carries the files. The new copy replaces the old
# one with two renames, and the old copy stays as app.old for a fast way back.
# macOS adds extended attributes that the tar of the phone does not know.
COPYFILE_DISABLE=1 tar --no-xattrs -czf - \
  --exclude='*.test.ts' --exclude='testkit.ts' --exclude='.DS_Store' \
  package.json server shared web/dist deploy/phone |
  remote 'set -e
    base="$HOME/shared-tasks"
    mkdir -p "$base/data"
    rm -rf "$base/app.new"
    mkdir -p "$base/app.new"
    tar -xzf - -C "$base/app.new"
    rm -rf "$base/app.old"
    [ -d "$base/app" ] && mv "$base/app" "$base/app.old"
    mv "$base/app.new" "$base/app"
    cp "$base/app/deploy/phone/start.sh" "$base/start.sh"
    chmod 700 "$base/start.sh"'

if ! remote 'grep -q "shared-tasks/start.sh" "$HOME/server/start-all.sh"'; then
  echo "Copied. The phone does not start this server yet. Run deploy/install-phone.sh one time."
  exit 0
fi

# The restart loop of the phone starts the server again after 5 seconds.
remote 'pkill -f "server/main.ts" 2>/dev/null || true'

echo "Copied. Waiting for the server..."
i=0
while [ "$i" -lt 20 ]; do
  if remote 'curl -fsS -m 3 http://127.0.0.1:5007/api/health' 2>/dev/null; then
    echo
    echo "The server answers."
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
echo "The server did not answer in 20 seconds. Read ~/server/log/tasks.log on the phone."
exit 1
