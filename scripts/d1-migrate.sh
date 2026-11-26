#!/usr/bin/env bash
# Applies workers/migrations/*.sql to the EdgeWatch D1 database.
#   scripts/d1-migrate.sh --remote   # the real database (needs bun run setup:cloudflare to have written database_id)
#   scripts/d1-migrate.sh --local    # wrangler dev state in .wrangler/state
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -gt 1 ]; then
  echo "Usage: scripts/d1-migrate.sh [--local|--remote]" >&2
  exit 1
fi
MODE="${1---local}"
case "$MODE" in
  --local|--remote) ;;
  *) echo "Usage: scripts/d1-migrate.sh [--local|--remote]" >&2; exit 1 ;;
esac
DB="${EDGEWATCH_D1_NAME:-edgewatch}"
cd "$ROOT/workers/consumer"
if [ "$MODE" = "--remote" ] && grep -q REPLACE_WITH_D1_DATABASE_ID wrangler.jsonc; then
  echo "workers/consumer/wrangler.jsonc still has the D1 placeholder id; run bun run setup:cloudflare first." >&2; exit 1
fi
args=(d1 migrations apply "$DB" "$MODE")
[ "$MODE" = "--local" ] && args+=(--persist-to "$ROOT/.wrangler/state")
bunx wrangler "${args[@]}"
