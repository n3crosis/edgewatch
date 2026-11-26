#!/usr/bin/env bash
# Runs scripts/e2e.sh with Postgres (through a local Hyperdrive binding) as the event store instead of D1.
# Uses E2E_POSTGRES_URL if set; otherwise starts a throwaway Postgres container (needs Docker).
#   PG_IMAGE   image to run (default mirror.gcr.io/library/postgres:16-alpine; Docker Hub can rate-limit)
#   PG_PORT    host port for the container (default 55433)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
container=""
if [ -z "${E2E_POSTGRES_URL:-}" ]; then
  PG_PORT="${PG_PORT:-55433}"
  container="edgewatch-e2e-pg-$$"
  docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=edgewatch -e POSTGRES_DB=edgewatch -p "127.0.0.1:$PG_PORT:5432" \
    "${PG_IMAGE:-mirror.gcr.io/library/postgres:16-alpine}" >/dev/null
  trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 30); do docker exec "$container" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done
  export E2E_POSTGRES_URL="postgres://postgres:edgewatch@127.0.0.1:$PG_PORT/edgewatch"
fi
E2E_DB=postgres bash "$ROOT/scripts/e2e.sh"
