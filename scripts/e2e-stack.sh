#!/usr/bin/env bash
# Isolated end-to-end API: never touches the development or production database.
#   API → http://localhost:4100 (local replica set, database jmh_e2e, storage .data/e2e-storage)
# The storefront side runs from the frontend repository (its scripts/e2e-web.sh, port 3100).
# Usage: scripts/e2e-stack.sh prepare|api
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export NODE_ENV=development
export PORT=4100
export APP_SECRET="e2e-only-secret-$(printf '%040d' 0)"
export MONGODB_URI="mongodb://127.0.0.1:${MONGO_PORT:-27018}/jmh_e2e?replicaSet=rs0&directConnection=true"
export PUBLIC_WEB_URL=http://localhost:3100
export MEDIA_PUBLIC_BASE_URL=http://localhost:3100/media
export STORAGE_DRIVER=local
export STORAGE_LOCAL_DIR="$ROOT/.data/e2e-storage"
export WHATSAPP_BUSINESS_NUMBER=919000000001   # obviously fake test number
export REVALIDATE_SECRET=e2e-revalidate-secret-123
export WEB_REVALIDATE_URL=http://localhost:3100/api/revalidate
export RATE_LIMITS=off
export INTERNAL_API_TOKEN=e2e-internal-token-0123456789abcdef   # test-only; exercises the proxy path
export LOG_LEVEL=warn
export BOOTSTRAP_ADMIN_EMAIL=e2e.owner@example.com
export BOOTSTRAP_ADMIN_PASSWORD='E2e-Temporary-Kiln-2026!'
export BOOTSTRAP_ADMIN_NAME='E2E Owner'

case "${1:-}" in
  prepare)
    # Fresh database every run.
    node -e "
      const { MongoClient } = require('$ROOT/node_modules/mongodb');
      (async () => { const c = await MongoClient.connect(process.env.MONGODB_URI); await c.db().dropDatabase(); await c.close(); })();
    "
    rm -rf "$STORAGE_LOCAL_DIR"
    cd "$ROOT"
    npx tsx scripts/migrate.ts
    npx tsx scripts/seed-demo.ts
    npx tsx scripts/bootstrap-admin.ts
    ;;
  api)
    cd "$ROOT" && exec npx tsx src/server.ts
    ;;
  *) echo "Usage: $0 prepare|api"; exit 1 ;;
esac
