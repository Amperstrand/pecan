#!/bin/sh
# Build pecan on ai-legion-small (32GB RAM, x86_64) and deploy to inr2 (3.8GB, no compile).
# The server OOMs when compiling Rust in Docker — never build there again.
# Usage: scripts/deploy.sh
set -eu

SERVER=root@46.224.104.12
BUILDER=ai-legion-small
REMOTE_DIR=/tmp/pecan-build
COMPOSE_DIR=/opt/pecan
URL=https://giftcard.cashu.exchange

cd "$(dirname "$0")/.."

echo "==> rsync source to ${BUILDER}:${REMOTE_DIR}"
ssh "$BUILDER" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR"
rsync -az --exclude node_modules --exclude target --exclude .git --exclude dist \
  ./ "$BUILDER:$REMOTE_DIR/"

echo "==> build image on $BUILDER (32GB RAM)"
ssh "$BUILDER" "cd $REMOTE_DIR && DOCKER_BUILDKIT=1 docker build -t pecan:eur . 2>&1 | tail -3"

echo "==> ship image to server"
ssh "$BUILDER" "docker save pecan:eur | gzip > $REMOTE_DIR/pecan-eur.tar.gz"
scp -q "$BUILDER:$REMOTE_DIR/pecan-eur.tar.gz" /tmp/pecan-eur.tar.gz
scp -q /tmp/pecan-eur.tar.gz "$SERVER:/tmp/pecan-eur.tar.gz"
ssh "$BUILDER" "docker rmi pecan:eur 2>/dev/null; rm -rf $REMOTE_DIR"

echo "==> load + deploy on server"
ssh "$SERVER" "gunzip -f /tmp/pecan-eur.tar.gz && docker load -i /tmp/pecan-eur.tar && rm -f /tmp/pecan-eur.tar* && docker tag pecan:eur pecan:nok"

echo "==> rsync compose file"
rsync -az deploy/docker-compose.prod.yml "$SERVER:$COMPOSE_DIR/docker-compose.prod.yml"

echo "==> recreate containers (no build on server)"
ssh "$SERVER" "cd $COMPOSE_DIR && docker compose -f docker-compose.prod.yml up -d --force-recreate 2>&1 | tail -1"

echo "==> restart mint (boot-order dependency)"
ssh "$SERVER" "docker restart giftcard-mint-mintd-1 >/dev/null 2>&1 && echo 'mint restarted' || echo 'WARN: mint restart failed'"

rm -f /tmp/pecan-eur.tar.gz

sleep 6
BUNDLE=$(curl -s -m 10 "$URL/console/wallet" | grep -o 'index-[^"]*\.js' | head -1)
if [ -z "$BUNDLE" ]; then
  echo "!! deploy verification failed: no bundle found at $URL/console/wallet" >&2
  exit 1
fi
echo "==> deployed: $BUNDLE"
