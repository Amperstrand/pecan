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
// THE CAR RAMPS LIKE A REAL ONE: 3 kW for the first STAGE1_S seconds
// (pilot handshake, conservative entry), 7 kW for the next STAGE2_S
// (negotiated step-up), then 22 kW (full three-phase AC). Stage
// lengths come from the service env (default the realistic 30/30;
// test lanes shrink them via scripts/virtual-charger.sh stages).
//
// Runs on inr2 as ev-virtual-charger.service (EnvironmentFile=/opt/
// atom-bridge/.env for MQTT creds); lifecycle is owned by
// scripts/virtual-charger.sh.
import mqtt from "mqtt"

const DEVICE = "atomV"
const STATUS = `charger/${DEVICE}/status`
const METER = `charger/${DEVICE}/meter`
const STAGE1_S = Number(process.env.STAGE1_S ?? 30)
const STAGE2_S = Number(process.env.STAGE2_S ?? 30)
const STAGES = [
  { after: 0, kw: 3 },
  { after: STAGE1_S, kw: 7 },
  { after: STAGE1_S + STAGE2_S, kw: 22 },
]

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
let sessionStart = 0
let currentKw = 0
let whDelivered = 0
let kwsDelivered = 0

function nextLoad(elapsedS) {
  // The LAST stage whose `after` has been reached wins; stage 1
  // (after: 0) is the default — the inverted comparison once skipped
  // it entirely (the car entered at 7 kW, never 3).
  let kw = STAGES[0].kw
  for (const st of STAGES) {
    if (elapsedS >= st.after) kw = st.kw
  }
  return Math.round(kw * 10) / 10
}

function log(msg, extra = "") {
  console.log(`${new Date().toISOString()} ${msg} ${extra}`.trimEnd())
}

function publishMeter() {
  client.publish(
    METER,
    JSON.stringify({
      kw: sessionActive ? currentKw : null,
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
  sessionStart = Date.now()
  whDelivered = 0
  kwsDelivered = 0
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
    currentKw = nextLoad((Date.now() - sessionStart) / 1000)
    whDelivered += currentKw / 3.6
    kwsDelivered += currentKw
  }
}, 1000)
setInterval(publishMeter, 2000)

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
client.on("error", (err) => log("mqtt error:", err.message))
