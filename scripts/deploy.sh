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

echo "==> rsync prod compose to /opt/pecan"
rsync -az deploy/docker-compose.prod.yml "$SERVER:$COMPOSE_DIR/docker-compose.prod.yml"

echo "==> prune builder cache (disk headroom) and build image"
ssh "$SERVER" "docker builder prune -af >/dev/null 2>&1 || true; cd $REMOTE_DIR && DOCKER_BUILDKIT=1 docker build -t pecan:nok . > /tmp/pecan-build.log 2>&1; status=\$?; tail -3 /tmp/pecan-build.log; if [ \$status -ne 0 ]; then echo '!! docker build failed — full log: /tmp/pecan-build.log on server' >&2; exit 1; fi"

echo "==> recreate containers"
ssh "$SERVER" "cd $COMPOSE_DIR && docker compose -f docker-compose.prod.yml up -d --force-recreate 2>&1 | tail -1"

# The mint reads the processor's get_settings (rails, units) only at boot and
# holds a gRPC connection; recreating pecan orphans that state — restart it
# or quotes fail with "Invalid payment method".
ssh "$SERVER" "docker restart giftcard-mint-mintd-1 >/dev/null 2>&1 && echo 'mint restarted' || echo 'WARN: mint restart failed — run it manually'"

sleep 4
BUNDLE=$(curl -s "$URL/console/wallet" | grep -o 'index-[^"]*\.js' | head -1)
if [ -z "$BUNDLE" ]; then
  echo "!! deploy verification failed: no bundle found at $URL/console/wallet" >&2
  exit 1
fi
echo "==> deployed: $BUNDLE"
