#!/usr/bin/env bash
# Local development services:
#   - MongoDB single-node replica set (transactions need a replica set) on 127.0.0.1:${MONGO_PORT:-27018}
#   - Redis on 127.0.0.1:${REDIS_PORT:-6380} via Docker (optional; enables BullMQ + shared rate limits)
# Data lives in ./.data (git-ignored). Usage: scripts/dev-services.sh start|stop|status
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.data"
MONGO_PORT="${MONGO_PORT:-27018}"
REDIS_PORT="${REDIS_PORT:-6380}"
REDIS_IMAGE="${REDIS_IMAGE:-redis:7.4-alpine}"
REDIS_CONTAINER="${REDIS_CONTAINER:-jmh-redis}"

mongo_running() { pgrep -f "mongod .*--port $MONGO_PORT" >/dev/null 2>&1; }

start() {
  mkdir -p "$DATA/mongo"
  if mongo_running; then
    echo "• MongoDB already running on port $MONGO_PORT"
  else
    command -v mongod >/dev/null || { echo "mongod not found. Install MongoDB 7+ or use Docker (see docs/DEVELOPMENT.md)."; exit 1; }
    mongod --dbpath "$DATA/mongo" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --replSet rs0 \
      --wiredTigerCacheSizeGB 0.5 --fork --logpath "$DATA/mongod.log" >/dev/null
    echo "✔ MongoDB started on port $MONGO_PORT (log: .data/mongod.log)"
  fi
  node "$ROOT/scripts/init-replica-set.mjs" "127.0.0.1:$MONGO_PORT"

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if docker ps --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
      echo "• Redis already running on port $REDIS_PORT"
    elif docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
      docker start "$REDIS_CONTAINER" >/dev/null && echo "✔ Redis started on port $REDIS_PORT"
    else
      docker run -d --name "$REDIS_CONTAINER" -p "127.0.0.1:$REDIS_PORT:6379" "$REDIS_IMAGE" \
        redis-server --save "" --appendonly no >/dev/null && echo "✔ Redis started on port $REDIS_PORT"
    fi
  else
    echo "• Docker not available: skipping Redis (jobs run in-process; set REDIS_URL to use BullMQ)"
  fi
}

stop() {
  if mongo_running; then
    mongod --shutdown --dbpath "$DATA/mongo" >/dev/null 2>&1 || pkill -f "mongod .*--port $MONGO_PORT" || true
    echo "✔ MongoDB stopped"
  fi
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
    docker stop "$REDIS_CONTAINER" >/dev/null && echo "✔ Redis stopped"
  fi
}

status() {
  mongo_running && echo "MongoDB: running ($MONGO_PORT)" || echo "MongoDB: stopped"
  if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER" && echo "Redis: running ($REDIS_PORT)" || echo "Redis: stopped"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "Usage: $0 start|stop|status"; exit 1 ;;
esac
