#!/bin/sh
# Build pecan on ai-legion-small (32GB RAM, x86_64) and deploy to inr2 (3.8GB, no compile).
# The server OOMs when compiling Rust in Docker — never build there again.
# Usage: scripts/deploy.sh
set -eu

SERVER=root@46.224.104.12
BUILDER=ai-legion-small
REMOTE_DIR=/tmp/pecan-build
URL=https://giftcard.cashu.exchange
# One artifact serves every pair (the unit comes from each compose's
# env) — one tag everywhere. The old scheme built pecan:eur, retagged
# pecan:nok, and the three composes referenced a scrambled mix
# (prod.yml said nok, nok.yml said eur) that only worked because every
# tag happened to hold the same bytes.
IMAGE=pecan:deployment

cd "$(dirname "$0")/.."
. scripts/pairs.sh

echo "==> rsync source to ${BUILDER}:${REMOTE_DIR}"
ssh "$BUILDER" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR"
rsync -az --exclude node_modules --exclude target --exclude .git --exclude dist \
  ./ "$BUILDER:$REMOTE_DIR/"

echo "==> build image on $BUILDER (32GB RAM)"
ssh "$BUILDER" "cd $REMOTE_DIR && DOCKER_BUILDKIT=1 docker build -t $IMAGE . 2>&1 | tail -3"

echo "==> ship image to server"
ssh "$BUILDER" "docker save $IMAGE | gzip > $REMOTE_DIR/pecan-image.tar.gz"
scp -q "$BUILDER:$REMOTE_DIR/pecan-image.tar.gz" /tmp/pecan-image.tar.gz
scp -q /tmp/pecan-image.tar.gz "$SERVER:/tmp/pecan-image.tar.gz"
ssh "$BUILDER" "docker rmi $IMAGE 2>/dev/null; rm -rf $REMOTE_DIR"

echo "==> load + deploy on server"
ssh "$SERVER" "gunzip -f /tmp/pecan-image.tar.gz && docker load -i /tmp/pecan-image.tar && rm -f /tmp/pecan-image.tar*"

echo "==> rsync compose files (all pairs are repo-tracked — a server-only
USD copy once drifted and crash-looped the pair)"
for u in $PAIRS; do
  rsync -az "$(pair_field "$u" compose)" "$SERVER:$(pair_field "$u" compose_remote)"
done

# Server-side tooling rides the same lane: reconcile-server.sh + core +
# the pair manifest it now sources. A manually-copied /opt/pecan-tools
# copy once lagged the repo (no NOK pair in reconcile for a day).
rsync -az scripts/pairs.sh scripts/reconcile-server.sh scripts/reconcile-core.py payout/ev-charge.py "$SERVER:/opt/pecan-tools/"

echo "==> recreate containers (no build on server)"
# Without the force-recreate a twin keeps serving the previous bundle
# (bit us during the soak hardening: EUR fixed, USD stale).
for u in $PAIRS; do
  ssh "$SERVER" "cd $(pair_field "$u" server_dir) && docker compose $(pair_field "$u" compose_flags) up -d --force-recreate 2>&1 | tail -1"
done

echo "==> restart mints (boot-order dependency)"
mints=""
for u in $PAIRS; do
  mints="$mints $(pair_field "$u" mint_container)"
done
ssh "$SERVER" "docker restart $mints >/dev/null 2>&1 && echo 'mints restarted' || echo 'WARN: mint restart failed'"
# A retagged image (mintd fork rebuilds) is not picked up by plain restart —
# recreate any pair container not running its tag's current image. Per-pair
# compose flags from the manifest: a bare `compose up` in /opt/pecan once
# picked the upstream DEV compose and rebuilt the EUR pair onto a legacy
# image name (pecan:nok), silently reverting the deployed bundle.
for u in $PAIRS; do
  ssh "$SERVER" "c='$(pair_field "$u" pecan_container)'; dir='$(pair_field "$u" server_dir)'; flags='$(pair_field "$u" compose_flags)';
img=\$(docker inspect "\$c" --format '{{.Image}}' 2>/dev/null) || exit 0
tag=\$(docker inspect "\$c" --format '{{.Config.Image}}' 2>/dev/null)
cur=\$(docker images --no-trunc --format '{{.ID}}' "\$tag" 2>/dev/null | head -1)
if [ -n "\$cur" ] && [ "\$img" != "\$cur" ]; then
  echo "\$c on stale image of \$tag, recreating"
  (cd "\$dir" && docker compose \$flags up -d --force-recreate >/dev/null 2>&1)
fi"
done

# inr2 disk is tight — drop the scrambled legacy tags once nothing runs
# on them (the recreate above moved every pair onto $IMAGE).
ssh "$SERVER" "docker rmi pecan:eur pecan:nok 2>/dev/null" || true

rm -f /tmp/pecan-image.tar.gz

sleep 6
fail=0
for pair in $PAIRS; do
  BUNDLE=$(curl -s -m 10 "$URL/$pair-console/wallet" | grep -o 'index-[^"]*\.js' | head -1)
  if [ -z "$BUNDLE" ]; then
    echo "!! deploy verification failed: no bundle at $URL/$pair-console/wallet" >&2
    fail=1
  else
    echo "==> deployed $pair: $BUNDLE"
  fi
done
exit $fail
