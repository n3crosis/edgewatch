#!/usr/bin/env bash
# Runs scripts/e2e.sh on the portable storage stack: Postgres (local Hyperdrive binding) for events, an S3-compatible
# bucket for traces instead of R2, and the Postgres kv_store table for API keys instead of KV. Only Queues stays Cloudflare.
#   E2E_POSTGRES_URL   use this Postgres instead of starting a container (needs Docker otherwise)
#   E2E_S3_ENDPOINT    use this S3 endpoint (with E2E_S3_BUCKET, E2E_S3_ACCESS_KEY_ID, E2E_S3_SECRET_ACCESS_KEY; the bucket
#                      must exist and allow anonymous ListObjectsV2 for the check) instead of a local moto server
#                      (pip install 'moto[server]')
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
moto=""
cleanup() { [ -n "$moto" ] && kill "$moto" 2>/dev/null || true; }
trap cleanup EXIT
if [ -z "${E2E_S3_ENDPOINT:-}" ]; then
  python3 -c 'import moto.server' 2>/dev/null || { echo "No E2E_S3_ENDPOINT and moto is not installed: pip install 'moto[server]'"; exit 1; }
  S3_PORT="${S3_PORT:-59010}"
  python3 -m moto.server -H 127.0.0.1 -p "$S3_PORT" >/dev/null 2>&1 & moto=$!
  export E2E_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" E2E_S3_BUCKET="edgewatch-traces"
  for _ in $(seq 1 30); do curl -fsS -o /dev/null "$E2E_S3_ENDPOINT/" 2>/dev/null && break; sleep 0.5; done
  curl -fsS -o /dev/null -X PUT "$E2E_S3_ENDPOINT/$E2E_S3_BUCKET"
fi
export E2E_BLOBS=s3 E2E_KEYS=sql
bash "$ROOT/scripts/e2e-postgres.sh"
