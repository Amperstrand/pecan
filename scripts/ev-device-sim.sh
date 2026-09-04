#!/usr/bin/env bash
# Start/stop/status for the ev device simulator (scripts/ev-device-sim.mjs)
# on inr2, next to the atom-gateway whose node_modules it borrows.
#
# WHY: the physical Atom charger is offline for a while; the sim keeps the
# whole ev rail (gateway → daemon → wallet e2es) testable without the box
# by impersonating the firmware on the shared HiveMQ fleet topics.
#
# Usage:
#   scripts/ev-device-sim.sh start    # upload + launch (12h TTL default)
#   scripts/ev-device-sim.sh stop     # clean stop (publishes offline)
#   scripts/ev-device-sim.sh status   # pid + retained box status probe
#
# WHEN THE REAL BOX RETURNS: run `stop` FIRST (the sim and the firmware
# share device ids; two "devices" acking the same window is undefined).
# The sim also refuses to start while the box status reads online.
set -eu

SERVER=root@46.224.104.12
BRIDGE_DIR=/opt/atom-bridge
REMOTE=$BRIDGE_DIR/ev-device-sim.mjs
PIDFILE=/run/ev-device-sim.pid
LOG=/var/log/ev-device-sim.log

case "${1:-}" in
start)
  scp -q "$(dirname "$0")/ev-device-sim.mjs" "$SERVER:$REMOTE"
  if ssh "$SERVER" "test -f $PIDFILE && kill -0 \$(cat $PIDFILE) 2>/dev/null"; then
    echo "sim already running (pid $(ssh "$SERVER" cat $PIDFILE))" >&2
    exit 1
  fi
  ssh "$SERVER" "cd $BRIDGE_DIR && set -a && . ./.env && set +a && \
    nohup node $REMOTE >> $LOG 2>&1 < /dev/null & echo \$! > $PIDFILE"
  sleep 3
  if ssh "$SERVER" "kill -0 \$(cat $PIDFILE) 2>/dev/null"; then
    echo "sim running: pid $(ssh "$SERVER" cat $PIDFILE), log $LOG"
  else
    echo "sim FAILED to stay up — tail of $LOG:" >&2
    ssh "$SERVER" "tail -5 $LOG" >&2 || true
    exit 1
  fi
  ;;
stop)
  ssh "$SERVER" "kill \$(cat $PIDFILE) 2>/dev/null || true; rm -f $PIDFILE" || true
  sleep 1
  echo "sim stopped (retained status now offline)"
  ;;
status)
  if ssh "$SERVER" "test -f $PIDFILE && kill -0 \$(cat $PIDFILE) 2>/dev/null"; then
    echo "pid: $(ssh "$SERVER" cat $PIDFILE) (running)"
  else
    echo "pid: none (not running)"
  fi
  ssh "$SERVER" "cd $BRIDGE_DIR && node -e \"
const mqtt = require('mqtt');
require('fs').readFileSync('.env','utf8').split('\\n').filter(l=>l.includes('=')&&!l.startsWith('#')).forEach(l=>{const i=l.indexOf('=');process.env[l.slice(0,i).trim()]=l.slice(i+1)});
const host = process.env.MQTT_URL.replace('mqtts://','').split(':')[0].split('/')[0];
const c = mqtt.connect('mqtts://'+host+':8883', {username: process.env.MQTT_USER, password: process.env.MQTT_PASS});
let got = false;
c.on('connect', () => c.subscribe('charger/atom/status'));
c.on('message', (t, p) => { got = true; console.log('box status (retained):', p.toString()); c.end(); });
setTimeout(() => { if (!got) { console.log('box status (retained): <none>'); c.end(); } }, 5000);
\""
  ;;
*)
  echo "usage: $0 start|stop|status" >&2
  exit 2
  ;;
esac
