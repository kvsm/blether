#!/usr/bin/env bash
# Checks a relay image works: starts it, waits for its health check, has a
# developer create a team on it, backs it up, and restarts it to check the
# team survived. Run from the repo root after `pnpm build`:
#
#   deploy/smoke-test.sh blether-relay:test
set -euo pipefail

image="${1:?usage: deploy/smoke-test.sh <image>}"
name="blether-relay-smoke-$$"
port=7399
home="$(mktemp -d)"
blether() { BLETHER_HOME="$home" node packages/bridge/dist/cli-bin.js "$@"; }
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$name" >/dev/null 2>&1 || true
  rm -rf "$home"
}
trap cleanup EXIT

start() {
  docker run -d --name "$name" -p "127.0.0.1:$port:7357" -v "$name:/data" "$image" >/dev/null
  for _ in $(seq 30); do
    if [ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy ]; then return; fi
    sleep 1
  done
  docker logs "$name"
  echo "relay never became healthy" >&2
  exit 1
}

start
curl -fsS "http://127.0.0.1:$port/healthz"

blether init --name Smoke
blether team create smoke --relay "ws://127.0.0.1:$port"
blether agent create smoke web
blether agent list smoke | grep -q "web"

docker exec "$name" node /app/dist/bin.js backup /data/backup.db
docker exec "$name" test -s /data/backup.db

# Mailboxes and teams live on the volume, so they outlast the container.
docker rm -f "$name" >/dev/null
start
blether agent list smoke | grep -q "web"

echo "smoke test passed"
