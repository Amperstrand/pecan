#!/usr/bin/env bash
# One-command live demo on the Mac screen: preflight the deployment and the
# charger fleet, fetch the NOK admin password, then run the visible browser
# orchestration (web/e2e/demo/live-demo.mjs) — top-up at the teller counter,
# approve in the admin console, melt to a live EV charger, monitor delivery.
#
# Usage: make demo   (or scripts/demo.sh)
# Skip the charger-online gate with PECAN_DEMO_SKIP_FLEET_CHECK=1.
set -eu

SERVER=root@46.224.104.12
URL=https://giftcard.cashu.exchange
DEVICE="${PECAN_DEMO_DEVICE:-atomD}"
export PECAN_DEMO_DEVICE="$DEVICE"
cd "$(dirname "$0")/.."

echo "==> preflight: NOK pair"
curl -fsS -m 10 "$URL/nok/v1/keys" >/dev/null && echo "    mint keys ok"
curl -fsS -m 10 "$URL/nok-console/healthz" >/dev/null && echo "    console health ok"

echo "==> preflight: charger fleet (retained MQTT status)"
EV_ENV=$(ssh "$SERVER" \
  "grep -E '^(MQTT_URL|MQTT_USER|MQTT_PASS)=' /opt/atom-bridge/.env" 2>/dev/null || true)
# Liveness topic per device: the sim-style devices retain charger/{id}/status
# (in either case), but the t-relay box behind atomD announces itself on the
# original box LWT charger/atom/status — "both chargers go dark with the box".
status_topics_for() {
  case "$1" in
    atomD) echo "atom atomD atomd" ;;
    *) echo "$1 $(printf '%s' "$1" | tr 'A-Z' 'a-z')" ;;
  esac
}

if [ -n "$EV_ENV" ]; then
  MQTT_URL=$(printf '%s\n' "$EV_ENV" | grep MQTT_URL | cut -d= -f2)
  MQTT_USER=$(printf '%s\n' "$EV_ENV" | grep MQTT_USER | cut -d= -f2)
  MQTT_PASS=$(printf '%s\n' "$EV_ENV" | grep MQTT_PASS | cut -d= -f2)
  fleet=$(python3 - "$MQTT_URL" "$MQTT_USER" "$MQTT_PASS" <<'PY' 2>/dev/null || true
import sys, time
try:
    import paho.mqtt.client as mqtt
except ImportError:
    print("paho-missing"); sys.exit(0)
url, user, pw = sys.argv[1:4]
host = url.replace("mqtts://", "").replace("mqtt://", "").split(":")[0]
seen = {}
def on_connect(c, u, f, rc, p=None):
    c.subscribe("charger/+/status")
def on_message(c, u, m):
    seen[m.topic.split("/")[1]] = m.payload.decode(errors="replace")
c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
c.username_pw_set(user, pw)
c.tls_set()
c.on_connect, c.on_message = on_connect, on_message
c.connect(host, 8883, 10)
c.loop_start()
time.sleep(4)
c.loop_stop(); c.disconnect()
print(" ".join(f"{d}={s}" for d, s in sorted(seen.items())) or "none-retained")
PY
)
  echo "    fleet: ${fleet:-unreachable}"
  if [ "${PECAN_DEMO_SKIP_FLEET_CHECK:-0}" != "1" ]; then
    online_via=""
    for cand in $(status_topics_for "$DEVICE"); do
      case " $fleet " in
        *" $cand=online"*) online_via="$cand" && break ;;
      esac
    done
    if [ -n "$online_via" ]; then
      echo "    $DEVICE is online (status topic: $online_via)"
    else
      echo "!! $DEVICE is not online (fleet: $fleet)." >&2
      echo "   Power the physical box — or demo hardware-free instead:" >&2
      echo "   PECAN_DEMO_DEVICE=atomV make demo   (virtual charger, always on)" >&2
      echo "   Override with PECAN_DEMO_SKIP_FLEET_CHECK=1 (the charge leg will then fail)." >&2
      exit 1
    fi
  fi
else
  echo "    WARN: could not fetch MQTT creds — skipping the fleet check" >&2
fi

echo "==> fetch NOK admin password"
PW=$(ssh "$SERVER" "cat /opt/pecan-nok-config/initial-admin-password.txt")
if [ -z "$PW" ]; then
  echo "no NOK admin password on the server" >&2
  exit 1
fi

echo "==> run the demo (Ctrl+C ends it and closes the browser)"
cd web
exec env PECAN_DEMO_ADMIN_PASSWORD="$PW" node e2e/demo/live-demo.mjs
