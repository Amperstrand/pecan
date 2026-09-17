#!/usr/bin/env bash
# Install/start/stop/status/selftest for the virtual charger (scripts/
# ev-virtual-charger.mjs) as ev-virtual-charger.service on inr2 —
# the API-only `atomV` device that keeps demos runnable with the whole
# physical fleet unplugged. MQTT creds come from the atom-bridge env.
#
# Usage:
#   scripts/virtual-charger.sh install   # upload + systemd unit + enable --now
#   scripts/virtual-charger.sh status    # service + retained atomV status
#   scripts/virtual-charger.sh selftest  # trigger a session; assert the
#                                        # staged ramp (3 kW entry) telemetry
#   scripts/virtual-charger.sh stages 30 30   # set ramp stage lengths (s)
#   scripts/virtual-charger.sh stop|start
set -eu

SERVER=root@46.224.104.12
BRIDGE_DIR=/opt/atom-bridge
REMOTE=$BRIDGE_DIR/ev-virtual-charger.mjs
UNIT=/etc/systemd/system/ev-virtual-charger.service

case "${1:-status}" in
install)
  scp -q "$(dirname "$0")/ev-virtual-charger.mjs" "$SERVER:$REMOTE"
  scp -q "$(dirname "$0")/ev-virtual-status.mjs" "$SERVER:$BRIDGE_DIR/ev-virtual-status.mjs"
  scp -q "$(dirname "$0")/ev-virtual-selftest.mjs" "$SERVER:$BRIDGE_DIR/ev-virtual-selftest.mjs"
  ssh "$SERVER" "cat > $UNIT" <<EOF
[Unit]
Description=Virtual EV charger (atomV) — API-only demo device
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$BRIDGE_DIR
EnvironmentFile=$BRIDGE_DIR/.env
ExecStart=/usr/bin/node $REMOTE
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  ssh "$SERVER" "systemctl daemon-reload && systemctl enable ev-virtual-charger && systemctl restart ev-virtual-charger"
  echo "installed + restarted (ev-virtual-charger.service)"
  ;;
selftest)
  ssh "$SERVER" "cd $BRIDGE_DIR && set -a && . ./.env && set +a && node ev-virtual-selftest.mjs"
  ;;
stages)
  S1=${2:?stage1 seconds required}; S2=${3:?stage2 seconds required}
  ssh "$SERVER" "mkdir -p /etc/systemd/system/ev-virtual-charger.service.d && printf '[Service]\nEnvironment=STAGE1_S=$S1 STAGE2_S=$S2\n' > /etc/systemd/system/ev-virtual-charger.service.d/stages.conf && systemctl daemon-reload && systemctl restart ev-virtual-charger && sleep 2 && systemctl is-active ev-virtual-charger"
  echo "ramp stages set: ${S1}s @3kW -> ${S2}s @7kW -> 22kW"
  ;;
start)
  ssh "$SERVER" "systemctl start ev-virtual-charger && echo started"
  ;;
stop)
  ssh "$SERVER" "systemctl stop ev-virtual-charger && echo 'stopped (retained status flips offline)'"
  ;;
status)
  ssh "$SERVER" "systemctl is-active ev-virtual-charger 2>/dev/null || echo inactive"
  ssh "$SERVER" "cd $BRIDGE_DIR && set -a && . ./.env && set +a && node ev-virtual-status.mjs"
  ;;
*)
  echo "usage: $0 install|start|stop|status" >&2
  exit 2
  ;;
esac
