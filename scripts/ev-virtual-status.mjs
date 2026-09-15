// One-shot probe: print atomV's retained status topic (used by
// scripts/virtual-charger.sh status). Run from /opt/atom-bridge with
// the env file sourced (MQTT_URL/USER/PASS).
import mqtt from "mqtt"

const host = process.env.MQTT_URL.replace("mqtts://", "").split(":")[0]
const c = mqtt.connect(`mqtts://${host}:8883`, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
})
let got = false
c.on("connect", () => c.subscribe("charger/atomV/status"))
c.on("message", (t, p) => {
  got = true
  console.log("atomV status (retained):", p.toString())
  c.end()
})
setTimeout(() => {
  if (!got) console.log("atomV status (retained): <none>")
  c.end()
}, 5000)
