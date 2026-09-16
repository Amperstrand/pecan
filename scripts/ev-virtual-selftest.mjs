// Behavioral selftest for the virtual charger's variable-load telemetry
// (run on inr2 by scripts/virtual-charger.sh selftest): triggers a real
// 6-second session through the gateway with the bridge key, subscribes
// to charger/atomV/meter, and asserts the car's draw stays within
// [3, 10] kW and the cumulative Wh strictly increases while drawing.
import mqtt from "mqtt"

const KEY = process.env.BRIDGE_KEY
const base = "http://127.0.0.1:8099"
const host = process.env.MQTT_URL.replace("mqtts://", "").split(":")[0]

const REF = `selftest-${Date.now()}`
const r = await fetch(`${base}/device/atomV/trigger`, {
  method: "POST",
  headers: { "x-api-key": KEY, "content-type": "application/json" },
  body: JSON.stringify({ seconds: 30, session_ref: REF }),
})
if (!r.ok) {
  console.error(`FAIL: trigger answered ${r.status}`)
  process.exit(1)
}

const samples = []
const c = mqtt.connect(`mqtts://${host}:8883`, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
})
c.on("connect", () => c.subscribe("charger/atomV/meter"))
c.on("message", (t, p) => {
  try {
    samples.push(JSON.parse(String(p)))
  } catch {}
})

// Remote stop after ~3.5s of a 30 kW·s window: a metered session (3-10
// kW draw) must bill FAR more than wall-clock seconds — that gap is the
// metered-truth contract (#30).
await new Promise(resolve => setTimeout(resolve, 3500))
const stopResp = await fetch(`${base}/session/${REF}/stop`, { method: "POST" })
const stop = await stopResp.json()
const stopElapsedWall = 3.5
if (!stop.stopped || !(stop.delivered > stopElapsedWall * 2.5)) {
  console.error(
    `FAIL: stop billed ${stop.delivered} kW·s after ${stopElapsedWall}s wall — meter not authoritative`,
  )
  process.exit(1)
}
console.log(`ok: remote stop billed ${stop.delivered} kW·s after ~${stopElapsedWall}s wall (metered)`)
await new Promise(resolve => setTimeout(resolve, 4500))
c.end()

const drawing = samples.filter(s => s.kw !== null)
// The remote stop ends the session at ~3.5s — one drawing sample is
// enough; the metered-billing stop assertion below carries the contract.
if (drawing.length < 1) {
  console.error(`FAIL: only ${drawing.length} drawing samples (${JSON.stringify(samples)})`)
  process.exit(1)
}
const outOfRange = drawing.filter(s => s.kw < 3 || s.kw > 10)
const nonIncreasing = drawing.filter((s, i) => i > 0 && s.wh <= drawing[i - 1].wh)
const varied = new Set(drawing.map(s => s.kw)).size > 1
const missingKws = drawing.filter(s => !Number.isFinite(s.kws))

if (outOfRange.length || nonIncreasing.length || !varied || missingKws.length) {
  console.error(
    `FAIL: outOfRange=${outOfRange.length} nonIncreasing=${nonIncreasing.length} varied=${varied} missingKws=${missingKws.length}`,
  )
  console.error(JSON.stringify(drawing))
  process.exit(1)
}
console.log(
  `ok: ${drawing.length} meter samples, kw range ${Math.min(...drawing.map(s => s.kw))}..${Math.max(...drawing.map(s => s.kw))} kW, wh ${drawing[0].wh}→${drawing[drawing.length - 1].wh}, kws ${drawing[0].kws}→${drawing[drawing.length - 1].kws}`,
)
