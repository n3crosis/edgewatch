#!/usr/bin/env bash
# Deploys the three Workers and the dashboard (Cloudflare Pages). Run scripts/cf-setup.mjs and scripts/d1-migrate.sh --remote first.
#   scripts/deploy.sh [workers|dashboard|all]
#   Dashboard env: VITE_API_URL (required, the deployed edgewatch-api URL), VITE_API_KEY (read key), VITE_PROJECT_ID,
#                  EDGEWATCH_PAGES_PROJECT (default edgewatch-dashboard)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHAT="${1:-all}"

if grep -rq "REPLACE_WITH_" "$ROOT"/workers/*/wrangler.jsonc; then
  echo "Placeholder resource IDs remain in workers/*/wrangler.jsonc; run node scripts/cf-setup.mjs first." >&2; exit 1
fi

if [ "$WHAT" = workers ] || [ "$WHAT" = all ]; then
  # Consumer first so the queue has a consumer before ingest starts producing.
  for w in consumer ingest api; do
    echo "==> wrangler deploy workers/$w"
    (cd "$ROOT/workers/$w" && npx wrangler deploy)
  done
fi

if [ "$WHAT" = dashboard ] || [ "$WHAT" = all ]; then
  : "${VITE_API_URL:?Set VITE_API_URL to the deployed edgewatch-api URL (or the dashboard will build in seed-data mode)}"
  echo "==> building apps/dashboard against $VITE_API_URL"
  pnpm --dir "$ROOT" --filter @edgewatch/dashboard build
  PROJECT="${EDGEWATCH_PAGES_PROJECT:-edgewatch-dashboard}"
  npx wrangler pages project create "$PROJECT" --production-branch main >/dev/null 2>&1 || true
  npx wrangler pages deploy "$ROOT/apps/dashboard/dist" --project-name "$PROJECT"
fi
