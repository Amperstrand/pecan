// atom-gateway — HTTP ↔ MQTT gateway for the virtual-charger fleet.
// Repo-tracked since 2026-09-16 (issue #30/#31); deployed to inr2 by
// scripts/atom-gateway.sh over /opt/atom-bridge/bridge.mjs (the systemd
// unit's path). Extensions over the original bridge:
//   * metered session truth — devices publish charger/{id}/meter
//     {"kw", "wh", "kws"}; while fresh (< METER_STALE_MS), delivered
//     comes from the device's cumulative kW·s instead of wall-clock,
//     and the gateway auto-caps the session at the requested budget
//     (metering devices draw 3-10 kW, so a budget burns 3-10x faster
//     than the wall-clock window). Meterless devices (the physical
//     fleet) keep the wall-clock contract unchanged.
//   * GET /public/{id} — unauthenticated, CORS-open device view for
//     the public charge-point page (#31): state + live draw. Device
//     ids are not secrets and meter data is non-sensitive.
//
// Supersedes the hermes-only atom-bridge (same /start /stop webhook, same
// shared-secret auth) and adds the pecan ev-rail device contract:
//
//   POST /device/{id}/trigger  {"seconds": N}   → charger/{id}/start
//        {"end": epochSec} (qos 1) — responds {"triggered": true, "session": …}
//   GET  /device/{id}/status   → {"state": "idle"|"running"|"done", …}
//   POST /start?device=… /stop?device=…          → hermes webhook (legacy)
//
// Session state comes from charger/{id}/ack ("start-acked"), charger/{id}/done
// ("countdown-finished") and the box status topic; an end-time fallback flips
// running→done if the done message is lost.
//
// Env: BRIDGE_KEY (shared secret), MQTT_URL (mqtts://…:8883),
// MQTT_USER, MQTT_PASS. Listens on 127.0.0.1:8099; caddy fronts it at
// https://giftcard.cashu.exchange/atom-gateway/*.
import http from "node:http";
import crypto from "node:crypto";
import mqtt from "mqtt";

const KEY = process.env.BRIDGE_KEY;
const client = mqtt.connect(process.env.MQTT_URL, {
  clientId: "atom-gateway",
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  reconnectPeriod: 2000,
});

/** device id → current session (atomA, atomB, …) */
const sessions = new Map();
/** device id → last meter reading ({"kw","wh","kws"}, always-on) */
const meters = new Map();
const METER_STALE_MS = 6000;
/** session ref (the melt quote id) → device id — the wallet-facing
 *  capability: status and stop endpoints authorize by this unguessable
 *  ref instead of the operator key. */
const refToDevice = new Map();

client.on("connect", () => {
  client.subscribe(
    ["charger/+/ack", "charger/+/done", "charger/+/aborted", "charger/+/meter", "charger/atom/status"],
    (err) => {
      if (err) console.error("subscribe failed:", err.message);
      else console.log("gateway subscribed to fleet topics");
    },
  );
});
function metered(s) {
  if (!s || !s.meter) return null;
  return Math.min(s.requested, Math.max(0, Math.round(s.meter.kws)));
}

client.on("message", (topic, payload) => {
  const meter = topic.match(/^charger\/([^/]+)\/meter$/);
  if (meter) {
    try {
      const parsed = JSON.parse(String(payload));
      const kws = Number(parsed.kws);
      if (Number.isFinite(kws)) {
        meters.set(meter[1], { ...parsed, at: Date.now() });
        const s = sessions.get(meter[1]);
        if (s && s.state === "running") s.meter = { kws, at: Date.now() };
      }
    } catch {}
    return;
  }
  const m = topic.match(/^charger\/([^/]+)\/(ack|done|aborted)$/);
  if (!m) {
    // charger/atom/status — box LWT: both chargers go dark with the box.
    if (topic === "charger/atom/status" && String(payload) !== "online") {
      for (const s of sessions.values()) if (s.state === "running") s.state = "idle";
    }
    return;
  }
  const [, id, kind] = m;
  const s = sessions.get(id);
  if (!s) return;
  if (kind === "ack" && String(payload) === "start-acked") s.acked = true;
  if (kind === "done") s.state = "done";
  if (kind === "aborted") {
    // The device is the metering authority: {"delivered": s} is its own
    // measurement (OCPP meterStop). Legacy firmware reported {"remaining"},
    // reconstructed against the requested window. Either way the session
    // counts as done, and delivered is clamped to the requested window so
    // a buggy device cannot bill beyond it.
    let delivered = null;
    try {
      const parsed = JSON.parse(String(payload));
      if (Number.isFinite(parsed.delivered)) delivered = parsed.delivered;
      else if (Number.isFinite(parsed.remaining))
        delivered = s.seconds - Math.max(0, parsed.remaining);
    } catch {
      delivered = null;
    }
    if (delivered === null) delivered = s.seconds;
    s.seconds = Math.min(Math.max(0, delivered), s.seconds);
    s.stopped = true;
    s.state = "done";
  }
});

// Fallback: a window whose end passed (with the device's ack) is done even
// if the done message was lost — never leave the adapter polling forever.
// The same sweep prunes session records older than an hour: sessions and
// their ref indexes are per-charge bookkeeping, not ledgers, and without
// pruning the maps grow forever on a long-lived host.
setInterval(() => {
  const now = Date.now() / 1000;
  for (const [id, s] of sessions) {
    // Metered truth: the device's cumulative kW·s IS the delivery.
    // Reaching the budget finalizes the session at full use and stops
    // the device (same relay-off + clamp semantics as a remote stop).
    if (s.state === "running" && s.meter && s.meter.kws >= s.requested) {
      client.publish(`charger/${id}/stop`, "OFF", { qos: 1 });
      s.seconds = s.requested;
      s.stopped = false;
      s.state = "done";
      console.log(`meter-capped ${id} at ${s.requested} kW·s (ref=${s.ref})`);
      continue;
    }
    if (s.state === "running" && s.acked && now > s.endAt + 2) s.state = "done";
    if (s.state !== "running" && now > s.endAt + 3600) {
      if (s.ref) refToDevice.delete(s.ref);
      sessions.delete(id);
    } else if (s.state === "running" && s.meter && Date.now() - s.meter.at > METER_STALE_MS) {
      s.meter = null; // stale telemetry: fall back to wall-clock truth
    }
  }
}, 1000);

const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,23}$/;

function authed(req, url) {
  // X-Bridge-Key is the legacy hermes-webhook header; X-API-Key is the
  // ev-rail device contract's header (ev-charge.py --gateway-key).
  const key = url.searchParams.get("key")
    ?? req.headers["x-bridge-key"]
    ?? req.headers["x-api-key"];
  return Boolean(KEY) && key === KEY;
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  // Wallet-facing session endpoints: the melt quote id is the capability.
  // No operator key — a customer may read their own session's progress
  // and stop it; anything beyond that still needs the key.
  const sess = url.pathname.match(/^\/session\/([^/]+)\/(status|stop)$/);
  if (sess) {
    const [, ref, action] = sess;
    const deviceId = refToDevice.get(ref);
    const st = sessions.get(deviceId ?? "");
    if (!st || st.ref !== ref) {
      return json(res, 404, { error: "unknown session" });
    }
    if (action === "status") {
      const now = Date.now() / 1000;
      // Explicit semantics: delivered counts UP from zero (what the
      // session actually provided so far), remaining counts down. A
      // fresh device meter is the authority (variable draw); the
      // wall-clock window is the meterless fallback. The aborted
      // handler leaves st.seconds at the delivered value.
      const meterKws = metered(st);
      let remaining, delivered;
      if (st.state === "running" && meterKws !== null) {
        delivered = meterKws;
        remaining = Math.max(0, st.requested - delivered);
      } else {
        remaining =
          st.state === "running" ? Math.max(0, Math.round(st.endAt - now)) : 0;
        delivered =
          st.state === "running"
            ? Math.min(st.seconds, Math.max(0, st.requested - remaining))
            : st.seconds;
      }
      return json(res, 200, {
        state: st.state,
        seconds: delivered,
        delivered,
        remaining,
        requested: st.requested,
        stopped: st.stopped,
        device: deviceId,
      });
    }
    // Stop: relay off first, then the same aborted message the device's
    // own button sends — the gateway computes delivered for remote stops
    // (the device stays the metering authority for its own button).
    if (st.state !== "running") {
      return json(res, 200, { stopped: false, state: st.state });
    }
    // Metered sessions stop at the METER's cumulative kW·s — the wall-
    // clock estimate here once under-billed a stop by 3x (metered 18,
    // billed 6): with a fresh meter the device's number is the truth.
    const meterKws = metered(st);
    const delivered =
      meterKws !== null
        ? meterKws
        : Math.min(st.requested, Math.max(0, st.requested - Math.max(0, Math.round(st.endAt - Date.now() / 1000))));
    client.publish(`charger/${deviceId}/stop`, "OFF", { qos: 1 });
    client.publish(
      `charger/${deviceId}/aborted`,
      JSON.stringify({ delivered }),
      { qos: 1 },
    );
    st.seconds = delivered;
    st.stopped = true;
    st.state = "done";
    console.log(`remote stop ${deviceId} ref=${ref} delivered=${delivered}`);
    return json(res, 200, { stopped: true, delivered });
  }

  // Public charge-point view (#31): device state + live draw, no key.
  const pub = url.pathname.match(/^\/public\/([a-zA-Z0-9_-]+)$/);
  if (pub) {
    const id = pub[1];
    const s = sessions.get(id);
    const m = meters.get(id);
    const fresh = m && Date.now() - m.at < METER_STALE_MS;
    res.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
    return res.end(JSON.stringify({
      device: id,
      state: s?.state ?? (fresh ? "idle" : "unknown"),
      kw: fresh ? m.kw : null,
      wh: fresh ? m.wh : null,
      kws: fresh ? m.kws : null,
      updated_ms: fresh ? Date.now() - m.at : null,
    }));
  }

  if (!authed(req, url)) return json(res, 403, { error: "forbidden" });

  // Legacy hermes webhook semantics.
  const legacy = url.pathname.replace(/^\/+|\/+$/g, "");
  if (legacy === "start" || legacy === "stop") {
    const device = (url.searchParams.get("device") ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!device) return json(res, 400, { error: "device required" });
    client.publish(`charger/${device}/${legacy}`, legacy === "start" ? "ON" : "OFF", { qos: 1 });
    return json(res, 200, { ok: true, topic: `charger/${device}/${legacy}` });
  }

  // ev-rail device contract.
  const dev = url.pathname.match(/^\/device\/([^/]+)\/(trigger|status)$/);
  if (!dev) return json(res, 404, { error: "use /device/{id}/trigger|/status" });
  const [, id, action] = dev;
  if (!SLUG.test(id)) return json(res, 400, { error: "bad device id" });

  if (action === "status") {
    const s = sessions.get(id);
    const running = s?.state === "running";
    const meterKws = running ? metered(s) : null;
    return json(res, 200, {
      state: s?.state ?? "idle",
      session: s?.session ?? null,
      seconds: running && meterKws !== null ? meterKws : (s?.seconds ?? 0),
      stopped: s?.stopped ?? false,
    });
  }

  let body = "";
  for await (const chunk of req) body += chunk;
  let seconds;
  try {
    seconds = Math.round(JSON.parse(body || "{}").seconds);
  } catch {
    return json(res, 400, { triggered: false, reason: "bad json" });
  }
  // `seconds` is the metered-energy budget in kW·s (issue #30), not
  // wall time — a realistic tariff authorizes thousands of kW·s per
  // unit; the meter caps delivery long before the legacy window could
  // matter. The old 3600 wall-cap rejected every realistic budget.
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10_000_000) {
    return json(res, 400, { triggered: false, reason: "seconds must be 1..10000000" });
  }
  const end = Math.floor(Date.now() / 1000) + seconds;
  const session = crypto.randomUUID();
  // session_ref links the window to the melt paying for it (the daemon
  // passes the quote id) — the wallet's slider and Stop button address
  // the session by this ref.
  let sessionRef = null;
  try {
    sessionRef = JSON.parse(body || "{}").session_ref ?? null;
  } catch {
    sessionRef = null;
  }
  const m = meters.get(id);
  sessions.set(id, {
    session, seconds, requested: seconds, endAt: end, acked: false,
    state: "running", ref: sessionRef,
    // Adopt a live meter if the device is already streaming one.
    meter: m && Date.now() - m.at < METER_STALE_MS ? { kws: 0, at: m.at } : null,
  });
  if (sessionRef && /^[A-Za-z0-9-]{8,64}$/.test(String(sessionRef))) {
    refToDevice.set(String(sessionRef), id);
  }
  client.publish(`charger/${id}/start`, JSON.stringify({ end }), { qos: 1 });
  console.log(`trigger ${id} seconds=${seconds} ref=${sessionRef}`);
  json(res, 200, { triggered: true, session });
});

server.listen(8099, "127.0.0.1", () => console.log("atom-gateway on 8099"));
