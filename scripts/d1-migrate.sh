#!/usr/bin/env bash
# Applies workers/migrations/*.sql to the EdgeWatch D1 database.
#   scripts/d1-migrate.sh --remote   # the real database (needs scripts/cf-setup.mjs to have written database_id)
#   scripts/d1-migrate.sh --local    # wrangler dev state in .wrangler/state
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:---local}"
DB="${EDGEWATCH_D1_NAME:-edgewatch}"
cd "$ROOT/workers/consumer"
if [ "$MODE" = "--remote" ] && grep -q REPLACE_WITH_D1_DATABASE_ID wrangler.jsonc; then
  echo "workers/consumer/wrangler.jsonc still has the D1 placeholder id; run node scripts/cf-setup.mjs first." >&2; exit 1
fi
args=(d1 migrations apply "$DB" "$MODE")
[ "$MODE" = "--local" ] && args+=(--persist-to "$ROOT/.wrangler/state")
npx wrangler "${args[@]}"
