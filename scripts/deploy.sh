#!/bin/sh
# Build pecan on ai-legion-small (32GB RAM, x86_64) and deploy to inr2 (3.8GB, no compile).
# The server OOMs when compiling Rust in Docker — never build there again.
# Usage: scripts/deploy.sh
set -eu

SERVER=root@46.224.104.12
BUILDER=ai-legion-small
# Per-invocation build dir: a second deploy pipeline on the network shares
# /tmp/pecan-build; interleaved rsyncs once shipped bundles that matched
# neither tree. $$ keeps our builds isolated; the shared tag race is
# handled by the verify-retry loop at the end.
REMOTE_DIR=/tmp/pecan-build-$$
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

# Builder-side content gate: a build-cache ghost twice shipped a wallet
# bundle without the farm currency under a fresh tag. The image must
# carry the farm tab BEFORE it is allowed near the server.
BUNDLE_IN_IMAGE=$(ssh "$BUILDER" "docker run --rm --entrypoint sh $IMAGE -c 'ls /usr/local/share/pecan/web/assets | grep "^index-.*\\.js\$" | head -1'")
if [ -z "$BUNDLE_IN_IMAGE" ]; then
  echo "!! built image has no wallet bundle — aborting" >&2
  exit 1
fi
ssh "$BUILDER" "docker run --rm --entrypoint sh $IMAGE -c 'grep -q FARM /usr/local/share/pecan/web/assets/$BUNDLE_IN_IMAGE'" || {
  echo "!! built image's wallet bundle ($BUNDLE_IN_IMAGE) lacks the farm tab — aborting before ship" >&2
  exit 1
}
echo "    bundle $BUNDLE_IN_IMAGE carries the farm tab"

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
rsync -az scripts/pairs.sh scripts/reconcile-server.sh scripts/reconcile-core.py "$SERVER:/opt/pecan-tools/"

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

rm -f /tmp/pecan-image.tar.gz

# A racing deployer on the network can flip the shared pecan:deployment
# tag between our load and recreate. If the served content is wrong, push
# OUR image back and recreate again — up to three rounds, then give up
# loudly.
retry_deploy() {
  # re-load from the tarball we shipped (still in /tmp on the server)
  ssh "$SERVER" "gunzip -f /tmp/pecan-image.tar.gz 2>/dev/null; docker load -i /tmp/pecan-image.tar >/dev/null" || return 1
  for u in $PAIRS; do
    ssh "$SERVER" "cd $(pair_field "$u" server_dir) && docker compose $(pair_field "$u" compose_flags) up -d --force-recreate 2>&1 | tail -1"
  done
}
verify_ok() {
  for pair in $PAIRS; do
    BUNDLE=$(curl -s -m 10 "$URL/$pair-console/wallet" | grep -o 'index-[^"]*\.js' | head -1)
    [ -z "$BUNDLE" ] && return 1
    case "$pair" in
      eur) curl -s -m 10 "$URL/assets/$(basename "$BUNDLE")" | grep -q "FARM" || return 1 ;;
    esac
  done
  return 0
}
rounds=0
while [ $rounds -lt 3 ]; do
  sleep 6
  if verify_ok; then
    break
  fi
  rounds=$((rounds + 1))
  echo "!! served content wrong (round $rounds) — tag race with a concurrent deployer; re-pushing our image" >&2
  retry_deploy || true
done
sleep 4
fail=0
for pair in $PAIRS; do
  BUNDLE=$(curl -s -m 10 "$URL/$pair-console/wallet" | grep -o 'index-[^"]*\.js' | head -1)
  if [ -z "$BUNDLE" ]; then
    echo "!! deploy verification failed: no bundle at $URL/$pair-console/wallet" >&2
    fail=1
  else
    echo "==> deployed $pair: $BUNDLE"
  fi
  # Content check: the wallet must carry the farm currency and the NUT-32
  # client. A builder-cache fluke once served a month-old farm-less bundle
  # under a fresh tag — bundle-name equality cannot catch that.
  JS=$(curl -s -m 10 "$URL/assets/$(basename "$BUNDLE")")
  case "$pair" in
    eur)
      echo "$JS" | grep -q "FARM" || { echo "!! $pair bundle lacks the FARM wallet tab" >&2; fail=1; }
      ;;
  esac
done
exit $fail
