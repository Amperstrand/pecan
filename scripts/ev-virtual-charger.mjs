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
//   publishes   charger/atomV/meter    {"kw": 3.0..10 | null, "wh": N,
//               "kws": cumulative kW·s} every 2s, always (idle kw=null)
//               — live telemetry for the display companion / public view
//               and (since #30) the gateway's metered session truth:
//               while the meter is fresh the session's delivered kW·s
//               comes from HERE, not wall-clock.
//
// THE CAR IS NOT CONSTANT: while a session runs, the simulated car's
// draw walks smoothly between 3 and 10 kW (an EV's onboard charger
// tapers and pauses; billing here stays on the gateway's per-second
// demo tariff — the meter topic is the car's own truth).
//
// Runs on inr2 as ev-virtual-charger.service (EnvironmentFile=/opt/
// atom-bridge/.env for MQTT creds); lifecycle is owned by
// scripts/virtual-charger.sh.
import mqtt from "mqtt"

const DEVICE = "atomV"
const STATUS = `charger/${DEVICE}/status`
const METER = `charger/${DEVICE}/meter`
const MIN_KW = 3
const MAX_KW = 10

const client = mqtt.connect(process.env.MQTT_URL, {
  clientId: `ev-virtual-${DEVICE}`,
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  reconnectPeriod: 2000,
  will: { topic: STATUS, payload: "offline", retain: true },
})

let timer = null
let sessions = 0

// The simulated car's draw: a bounded random walk with occasional
// deep dips (battery tapers / balancing pauses).
let sessionActive = false
let loadKw = 6.5
let whDelivered = 0
let kwsDelivered = 0

function nextLoad() {
  // Gentle-biased walk (better demo pacing): the base meanders 3-5.5 kW
  // with occasional spikes toward the 10 kW ceiling — real EVs taper
  // and pause; the billing contract stays the same [3, 10] kW.
  const drift = (Math.random() - 0.5) * 1.6
  loadKw = Math.min(MAX_KW, Math.max(MIN_KW, loadKw + drift))
  loadKw += (4.2 - loadKw) * 0.08
  if (Math.random() < 0.1) loadKw = 7 + Math.random() * 3
  if (Math.random() < 0.06) loadKw = MIN_KW + Math.random() * 0.8
  return Math.round(loadKw * 10) / 10
}

function log(msg, extra = "") {
  console.log(`${new Date().toISOString()} ${msg} ${extra}`.trimEnd())
}

function publishMeter() {
  client.publish(
    METER,
    JSON.stringify({
      kw: sessionActive ? Math.round(loadKw * 10) / 10 : null,
      wh: Math.round(whDelivered),
      kws: Math.round(kwsDelivered),
      state: sessionActive ? "drawing" : "idle",
    }),
    { qos: 0 },
  )
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
    sessionActive = false
    log(`stop — countdown killed at ${Math.round(whDelivered)} Wh drawn`)
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
  sessionActive = true
  whDelivered = 0
  kwsDelivered = 0
  loadKw = 6.5
  client.publish(`charger/${DEVICE}/ack`, "start-acked", { qos: 1 })
  const msLeft = end * 1000 - Date.now()
  log(`start end=${end} (${Math.max(0, Math.round(msLeft / 1000))}s) — acked`)
  if (msLeft <= 0) {
    sessionActive = false
    client.publish(`charger/${DEVICE}/done`, "countdown-finished", { qos: 1 })
    return
  }
  timer = setTimeout(() => {
    timer = null
    sessionActive = false
    client.publish(`charger/${DEVICE}/done`, "countdown-finished", { qos: 1 })
    log(`done — drew ${Math.round(whDelivered)} Wh`)
  }, msLeft)
})

// The car's draw ticks every second; the telemetry publishes every 2s.
setInterval(() => {
  if (sessionActive) {
    const kw = nextLoad()
    whDelivered += kw / 3.6
    kwsDelivered += kw
  }
}, 1000)
setInterval(publishMeter, 2000)

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
client.on("error", (err) => log("mqtt error:", err.message))
