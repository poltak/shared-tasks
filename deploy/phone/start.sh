#!/data/data/com.termux/files/usr/bin/sh
# Starts the Shared Tasks server on localhost only.
# Caddy puts HTTPS in front of it, so no other device gets plain HTTP.
# The settings of this phone are in ~/shared-tasks/env, which is not in the repository.
cd "$HOME/shared-tasks/app" || exit 1
export PORT=5007
export HOST=127.0.0.1
export DATA_DIR="$HOME/shared-tasks/data"
export WEB_DIR="$HOME/shared-tasks/app/web/dist"
export BACKUP_DIR="$HOME/backups"
# Node.js prints a warning for its built-in SQLite and TypeScript support on each start.
export NODE_NO_WARNINGS=1
[ -f "$HOME/shared-tasks/env" ] && . "$HOME/shared-tasks/env"
exec node server/main.ts
