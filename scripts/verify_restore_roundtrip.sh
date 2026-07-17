#!/usr/bin/env bash
# Verify an encrypted backup restores into a freshly reset local database.
#
# A production build (`next build` + `next start`) is used instead of the dev
# server: Turbopack dev-mode cold compiles can take ~90s after each container
# restart, whereas the production server responds immediately. A fresh server
# is started AFTER each `supabase db reset` so no stale Supabase connections
# survive the container reboot.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_PATH="${QDAG_SMOKE_BACKUP_PATH:-/tmp/qdag-empty-restore-smoke.qdag}"
PEPPER="local-integration-pepper-with-at-least-32-bytes"
DEV_PID=""

log() { printf '\n=== %s ===\n' "$1"; }

eval "$(npx --yes supabase@latest status -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY"
export SUPABASE_SECRET_KEY="$SECRET_KEY"
export API_TOKEN_PEPPER="$PEPPER"
export QDAG_SMOKE_BACKUP_PATH="$BACKUP_PATH"

stop_dev() {
  if [[ -n "$DEV_PID" ]] && kill -0 "$DEV_PID" 2>/dev/null; then
    pkill -P "$DEV_PID" 2>/dev/null || true
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  pkill -f "apps/web/node_modules/.bin/next start" 2>/dev/null || true
  pkill -f "apps/web/node_modules/.bin/next dev" 2>/dev/null || true
  DEV_PID=""
}

start_dev() {
  stop_dev
  ( cd "$ROOT/apps/web" && npm run start >/tmp/qdag-dev-server.log 2>&1 ) &
  DEV_PID=$!
  for _ in $(seq 1 90); do
    if curl -s -m 5 -o /dev/null "http://localhost:3000/login"; then
      return 0
    fi
    sleep 1
  done
  echo "web server did not become ready" >&2
  cat /tmp/qdag-dev-server.log >&2 || true
  return 1
}

trap stop_dev EXIT

log "build production web server once"
( cd "$ROOT/apps/web" && npm run build >/tmp/qdag-web-build.log 2>&1 ) \
  || { echo "web build failed" >&2; tail -n 40 /tmp/qdag-web-build.log >&2; exit 1; }

log "reset before backup creation"
npx --yes supabase@latest db reset

log "start fresh dev server"
start_dev

log "seed data and create persistent encrypted backup"
uv run --project packages/cli python scripts/smoke_api.py

log "reset to an empty database"
stop_dev
npx --yes supabase@latest db reset

log "restart dev server against empty database"
start_dev

log "restore encrypted backup and verify records plus artifact bytes"
uv run --project packages/cli python scripts/restore_smoke_backup.py

log "restore round-trip verification passed"
