// Behavioral selftest for the virtual charger's variable-load telemetry
// (run on inr2 by scripts/virtual-charger.sh selftest): triggers a real
// 6-second session through the gateway with the bridge key, subscribes
// to charger/atomV/meter, and asserts the car's draw stays within
// [3, 10] kW and the cumulative Wh strictly increases while drawing.
import mqtt from "mqtt"

const KEY = process.env.BRIDGE_KEY
const base = "http://127.0.0.1:8099"
const host = process.env.MQTT_URL.replace("mqtts://", "").split(":")[0]

const r = await fetch(`${base}/device/atomV/trigger`, {
  method: "POST",
  headers: { "x-api-key": KEY, "content-type": "application/json" },
  body: JSON.stringify({ seconds: 6 }),
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

await new Promise(resolve => setTimeout(resolve, 8000))
c.end()

const drawing = samples.filter(s => s.kw !== null)
if (drawing.length < 2) {
  console.error(`FAIL: only ${drawing.length} drawing samples (${JSON.stringify(samples)})`)
  process.exit(1)
}
const outOfRange = drawing.filter(s => s.kw < 3 || s.kw > 10)
const nonIncreasing = drawing.filter((s, i) => i > 0 && s.wh <= drawing[i - 1].wh)
const varied = new Set(drawing.map(s => s.kw)).size > 1

if (outOfRange.length || nonIncreasing.length || !varied) {
  console.error(
    `FAIL: outOfRange=${outOfRange.length} nonIncreasing=${nonIncreasing.length} varied=${varied}`,
  )
  console.error(JSON.stringify(drawing))
  process.exit(1)
}
console.log(
  `ok: ${drawing.length} meter samples, kw range ${Math.min(...drawing.map(s => s.kw))}..${Math.max(...drawing.map(s => s.kw))} kW, wh ${drawing[0].wh}→${drawing[drawing.length - 1].wh}`,
)
