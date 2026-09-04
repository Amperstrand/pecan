// ev-device-sim — MQTT stand-in for the physical Atom charger box while
// it is offline. Speaks the atom-gateway's device contract exactly as
// the ESPHome firmware does (see /opt/atom-bridge/bridge.mjs on inr2):
//
//   publishes   charger/atom/status   "online" (retained; will=offline)
//   subscribes  charger/{id}/start    {"end": epochSec} → ack + countdown
//   publishes   charger/{id}/ack      "start-acked"
//   publishes   charger/{id}/done     "countdown-finished" at window end
//   subscribes  charger/{id}/stop     "OFF" → relay off (countdown killed)
//
// The gateway extrapolates the running slider from the window end time
// and meters remote stops itself, so the sim needs no metering. The G39
// button path is driven separately by the e2e button-sim (it publishes
// charger/{id}/aborted on our ack); a late `done` after an abort is a
// no-op in the gateway.
//
// SAFETY: refuses to start if charger/atom/status is already retained
// "online" (the real box may be back, or a prior sim — a human decides;
// a cleanly-stopped sim leaves "offline" behind, and an unclean one's
// will flips it). Exits cleanly (retained "offline") on SIGTERM/SIGINT
// or after TTL_HOURS.
//
// Run on inr2 next to the gateway (its node_modules has mqtt):
//   cd /opt/atom-bridge && node ev-device-sim.mjs
// Lifecycle is owned by scripts/ev-device-sim.sh (start/stop/status) —
// do NOT leave this running once the physical box is back.
import mqtt from "mqtt"

const DEVICES = (process.env.DEVICES ?? "atomA,atomB")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean)
const TTL_HOURS = Number(process.env.TTL_HOURS ?? 12)
const BOX_STATUS = "charger/atom/status"

const client = mqtt.connect(process.env.MQTT_URL, {
  clientId: `ev-device-sim-${Date.now()}`,
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  reconnectPeriod: 2000,
  will: { topic: BOX_STATUS, payload: "offline", retain: true },
})

const timers = new Map() // device → countdown timeout
let announced = false

function log(msg, extra = "") {
  console.log(`${new Date().toISOString()} ${msg} ${extra}`.trimEnd())
}

function shutdown(reason, code = 0) {
  log(`exiting (${reason}) — publishing offline`)
  client.publish(BOX_STATUS, "offline", { retain: true, qos: 1 })
  for (const t of timers.values()) clearTimeout(t)
  client.end(false, {}, () => process.exit(code))
}

client.on("connect", () => {
  if (announced) {
    log("reconnected — subscriptions restored by the client")
    return
  }
  // Safety probe BEFORE announcing ourselves: an existing retained
  // "online" means the real box (or another sim) is up. Anything else
  // (offline / absent) means the fleet is dark and we may stand in.
  client.subscribe(BOX_STATUS)
  let sawOnline = false
  const probe = (topic, payload) => {
    if (topic === BOX_STATUS && String(payload) === "online") sawOnline = true
  }
  client.on("message", probe)
  setTimeout(() => {
    client.removeListener("message", probe)
    client.unsubscribe(BOX_STATUS)
    if (sawOnline) {
      log("REFUSING TO START: charger/atom/status is already retained online")
      process.exit(3)
    }
    announced = true
    client.publish(BOX_STATUS, "online", { retain: true, qos: 1 })
    for (const d of DEVICES) {
      client.subscribe([`charger/${d}/start`, `charger/${d}/stop`])
    }
    log(`online as ${DEVICES.join(",")} (TTL ${TTL_HOURS}h)`)
  }, 2000)
})

client.on("message", (topic, payload) => {
  const m = topic.match(/^charger\/([^/]+)\/(start|stop)$/)
  if (!m) return
  const [, id, kind] = m
  if (!DEVICES.includes(id)) return
  if (kind === "stop") {
    // Remote stop: the gateway computes delivered and finalizes the
    // session itself; the device only kills the relay (its countdown).
    const t = timers.get(id)
    if (t) clearTimeout(t)
    timers.delete(id)
    log(`stop ${id} — countdown killed`)
    return
  }
  let end
  try {
    end = JSON.parse(String(payload)).end
  } catch {
    return
  }
  if (!Number.isFinite(end)) return
  const t = timers.get(id)
  if (t) clearTimeout(t)
  client.publish(`charger/${id}/ack`, "start-acked", { qos: 1 })
  const msLeft = end * 1000 - Date.now()
  log(`start ${id} end=${end} (${Math.max(0, Math.round(msLeft / 1000))}s) — acked`)
  if (msLeft <= 0) {
    client.publish(`charger/${id}/done`, "countdown-finished", { qos: 1 })
    log(`done ${id} (window already past)`)
    return
  }
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      client.publish(`charger/${id}/done`, "countdown-finished", { qos: 1 })
      log(`done ${id}`)
    }, msLeft),
  )
})

setTimeout(() => shutdown(`TTL ${TTL_HOURS}h reached`), TTL_HOURS * 3600 * 1000)
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
client.on("error", (err) => log("mqtt error:", err.message))
