// ev-virtual-charger — the API-only charger (device id `atomV`).
//
// Same MQTT device contract as the firmware (see ev-device-sim.mjs and
// /opt/atom-bridge/bridge.mjs on inr2), but for a device that has NO
// physical counterpart: demos run end to end (wallet slider, delivered
// kW·s, stop, receipt, refund) with the entire hardware fleet unplugged.
//
//   publishes   charger/atomV/status  "online" (retained; will=offline)
//   subscribes  charger/atomV/start    {"end": epochSec} → ack + countdown
//   publishes   charger/atomV/ack      "start-acked"
//   publishes   charger/atomV/done     "countdown-finished" at window end
//   subscribes  charger/atomV/stop     "OFF" → countdown killed
//
// Differences from ev-device-sim: no TTL (always-on), no start-refusal
// (atomV has no physical twin to collide with), delivery cadence is
// wall-clock 1 s per requested kW·s — identical to the real fleet, so
// the wallet slider moves at demo-realistic speed.
//
// Runs on inr2 as ev-virtual-charger.service (EnvironmentFile=/opt/
// atom-bridge/.env for MQTT creds); lifecycle is owned by
// scripts/virtual-charger.sh.
import mqtt from "mqtt"

const DEVICE = "atomV"
const STATUS = `charger/${DEVICE}/status`

const client = mqtt.connect(process.env.MQTT_URL, {
  clientId: `ev-virtual-${DEVICE}`,
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  reconnectPeriod: 2000,
  will: { topic: STATUS, payload: "offline", retain: true },
})

let timer = null
let sessions = 0

function log(msg, extra = "") {
  console.log(`${new Date().toISOString()} ${msg} ${extra}`.trimEnd())
}

function shutdown(reason) {
  log(`exiting (${reason}) — publishing offline`)
  if (timer) clearTimeout(timer)
  client.publish(STATUS, "offline", { retain: true, qos: 1 })
  client.end(false, {}, () => process.exit(0))
}

client.on("connect", () => {
  client.publish(STATUS, "online", { retain: true, qos: 1 })
  client.subscribe([`charger/${DEVICE}/start`, `charger/${DEVICE}/stop`])
  log(`virtual charger ${DEVICE} online (sessions so far: ${sessions})`)
})

client.on("message", (topic, payload) => {
  if (topic === `charger/${DEVICE}/stop`) {
    // The gateway computes delivered and finalizes the session itself;
    // the device only stops delivering.
    if (timer) clearTimeout(timer)
    timer = null
    log("stop — countdown killed")
    return
  }
  let end
  try {
    end = JSON.parse(String(payload)).end
  } catch {
    return
  }
  if (!Number.isFinite(end)) return
  sessions += 1
  if (timer) clearTimeout(timer)
  client.publish(`charger/${DEVICE}/ack`, "start-acked", { qos: 1 })
  const msLeft = end * 1000 - Date.now()
  log(`start end=${end} (${Math.max(0, Math.round(msLeft / 1000))}s) — acked`)
  if (msLeft <= 0) {
    client.publish(`charger/${DEVICE}/done`, "countdown-finished", { qos: 1 })
    return
  }
  timer = setTimeout(() => {
    timer = null
    client.publish(`charger/${DEVICE}/done`, "countdown-finished", { qos: 1 })
    log("done")
  }, msLeft)
})

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
client.on("error", (err) => log("mqtt error:", err.message))
