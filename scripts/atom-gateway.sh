#!/usr/bin/env bash
# Deploy the repo-tracked atom-gateway (gateway/atom-gateway.mjs) to inr2
# over /opt/atom-bridge/bridge.mjs (the systemd unit's path — previous
# copy kept as bridge.mjs.bak) plus the public charge-point page to the
# static root site. Restart atom-bridge and verify.
#
# Usage: scripts/atom-gateway.sh install|verify
set -eu

SERVER=root@46.224.104.12
BRIDGE_DIR=/opt/atom-bridge
WWW=/var/www/giftcard.cashu.exchange

case "${1:-verify}" in
install)
  scp -q gateway/atom-gateway.mjs "$SERVER:$BRIDGE_DIR/bridge.mjs.new"
  scp -q gateway/public/chargepoint.html "$SERVER:$WWW/chargepoint.html"
  ssh "$SERVER" "cd $BRIDGE_DIR && cp bridge.mjs bridge.mjs.bak && mv bridge.mjs.new bridge.mjs && systemctl restart atom-bridge && sleep 2 && systemctl is-active atom-bridge"
  echo "gateway deployed + restarted (previous copy: $BRIDGE_DIR/bridge.mjs.bak)"
  ;;
verify)
  echo "== service =="; ssh "$SERVER" "systemctl is-active atom-bridge"
  echo "== authed device status =="; ssh "$SERVER" 'KEY=$(grep "^BRIDGE_KEY=" /opt/atom-bridge/.env | cut -d= -f2-); curl -s -m 5 http://127.0.0.1:8099/device/atomV/status -H "X-API-Key: $KEY"'
  echo; echo "== public endpoint (no key) =="
  curl -s -m 8 https://giftcard.cashu.exchange/atom-gateway/public/atomV -D - | grep -iE "^HTTP|access-control|^\{" | head -4
  echo "== public page =="
  curl -s -o /dev/null -w "%{http_code}\n" -m 8 https://giftcard.cashu.exchange/chargepoint.html
  ;;
*)
  echo "usage: $0 install|verify" >&2; exit 2 ;;
esac
