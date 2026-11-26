#!/usr/bin/env bash
# Deploys the three Workers and the dashboard (Cloudflare Pages). Run bun run setup:cloudflare first (it also applies D1 migrations).
#   scripts/deploy.sh [workers|dashboard|all]
#   Dashboard env: VITE_API_URL (required, the deployed edgewatch-api URL), VITE_PROJECT_ID,
#                  EDGEWATCH_PAGES_PROJECT (default edgewatch-dashboard)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHAT="${1:-all}"

if [ "$#" -gt 1 ]; then echo "Usage: scripts/deploy.sh [workers|dashboard|all]" >&2; exit 2; fi
case "$WHAT" in
  workers|dashboard|all) ;;
  *) echo "Unknown deployment target: $WHAT. Use workers, dashboard, or all." >&2; exit 2 ;;
esac

if [ "$WHAT" = workers ] || [ "$WHAT" = all ]; then
  for w in consumer ingest api; do
    config="$ROOT/workers/$w/wrangler.jsonc"
    if [ ! -f "$config" ]; then echo "Missing Worker configuration: $config" >&2; exit 1; fi
    if grep -q "REPLACE_WITH_" "$config"; then
      echo "Placeholder resource IDs remain in workers/$w/wrangler.jsonc; run bun run setup:cloudflare first." >&2; exit 1
    fi
  done
fi

# Complete local dashboard validation and build before changing any deployed Worker.
if [ "$WHAT" = dashboard ] || [ "$WHAT" = all ]; then
  : "${VITE_API_URL:?Set VITE_API_URL to the deployed edgewatch-api URL (or the dashboard will build in seed-data mode)}"
  bun -e '
    const value = process.env.VITE_API_URL;
    try {
      if (!value || value !== value.trim() || !(/^(https?:\/\/|\/(?!\/))/i.test(value))) throw new Error();
      const url = new URL(value, "https://edgewatch.invalid");
      if (value.startsWith("/") && url.origin !== "https://edgewatch.invalid") throw new Error();
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { console.error("VITE_API_URL must be an HTTP(S) URL or root-relative path without credentials, query or fragment."); process.exit(1); }
  '
  if [ -n "${VITE_API_KEY:-}" ]; then echo "VITE_API_KEY is no longer used: the dashboard asks for the read key at sign-in. Ignoring it." >&2; unset VITE_API_KEY; fi
  echo "==> building apps/dashboard against $VITE_API_URL"
  (cd "$ROOT" && bun run --filter @edgewatch/dashboard build)
fi

if [ "$WHAT" = workers ] || [ "$WHAT" = all ]; then
  # Consumer first so the queue has a consumer before ingest starts producing.
  for w in consumer ingest api; do
    echo "==> wrangler deploy workers/$w"
    (cd "$ROOT/workers/$w" && bunx wrangler deploy)
  done
fi

if [ "$WHAT" = dashboard ] || [ "$WHAT" = all ]; then
  PROJECT="${EDGEWATCH_PAGES_PROJECT:-edgewatch-dashboard}"
  (cd "$ROOT/workers/api" && bunx wrangler pages project create "$PROJECT" --production-branch main --force) >/dev/null 2>&1 || true
  (cd "$ROOT/workers/api" && bunx wrangler pages deploy "$ROOT/apps/dashboard/dist" --project-name "$PROJECT" --cwd "$ROOT/apps/dashboard")
fi
