#!/bin/sh
# Deploy pecan to inr2: rsync source, docker build, recreate containers, verify.
# Usage: scripts/deploy.sh
set -eu

SERVER=root@46.224.104.12
REMOTE_DIR=/root/pecan-src
COMPOSE_DIR=/opt/pecan
URL=https://giftcard.cashu.exchange

cd "$(dirname "$0")/.."

echo "==> rsync source to ${SERVER}:${REMOTE_DIR}"
rsync -az --exclude node_modules --exclude target --exclude .git --exclude dist ./ "$SERVER:$REMOTE_DIR/"

echo "==> prune builder cache (disk headroom) and build image"
ssh "$SERVER" "docker builder prune -af >/dev/null 2>&1 || true; cd $REMOTE_DIR && DOCKER_BUILDKIT=1 docker build -t pecan:nok . 2>&1 | tail -1"

echo "==> recreate containers"
ssh "$SERVER" "cd $COMPOSE_DIR && docker compose -f docker-compose.prod.yml up -d --force-recreate 2>&1 | tail -1"

sleep 4
BUNDLE=$(curl -s "$URL/console/wallet" | grep -o 'index-[^"]*\.js' | head -1)
if [ -z "$BUNDLE" ]; then
  echo "!! deploy verification failed: no bundle found at $URL/console/wallet" >&2
  exit 1
fi
echo "==> deployed: $BUNDLE"
