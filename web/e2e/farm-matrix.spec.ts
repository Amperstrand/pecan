import { createHash } from "node:crypto"
import { test, expect, type APIRequestContext } from "@playwright/test"
import { caseOf } from "./helpers/farm-matrix-log"

// The farm API-tier matrix: an enumeration of every user-reachable
// request shape across the oracle, purchases, terms, and both quote
// surfaces (mint + melt), parametrized over dates, quantities, units,
// and delivery rails. Every case lands in
// e2e/.results/farm-matrix-results.jsonl (scripts/farm-analyze.py
// summarizes); valid BUY cases are tiny (1 egg) because autopay
// settles them into 24h capacity reservations.
//
// Run: scripts/farm-fuzz.sh   (or: cd web && PECAN_FARM_ADMIN_PASSWORD=… \
//        npx playwright test farm-matrix --reporter=line)

const FARM_BASE = "/farm-console"
const MINT = "/farm"
const PASSWORD = process.env.PECAN_FARM_ADMIN_PASSWORD ?? ""
const SUITE = "farm-matrix"
const DUMMY_PUBKEY = "02" + "ab".repeat(32)

interface Series {
  date: string
  unit: string
  maturity: number
  capacity: number
  issued: number
  redeemed: number
  available: number
  price_sats: number
  terms_uri: string
  terms_sha256: string
  matured: boolean
}

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
}

async function overview(r: APIRequestContext): Promise<{ series: Series[] }> {
  const resp = await r.get(`${FARM_BASE}/api/farm`)
  expect(resp.status()).toBe(200)
  return await resp.json()
}

// One-off 5xx happens against the live rig (a CLN RPC hiccup once
// 503'd a buy) — transient server errors retry; 4xx never does.
async function withRetry(
  run: () => Promise<{ status(): number }>,
): Promise<{ status(): number }> {
  let resp = await run()
  for (let i = 0; i < 2 && resp.status() >= 500; i++) {
    await new Promise((r2) => setTimeout(r2, 1_000))
    resp = await run()
  }
  return resp
}

function buyQuote(r: APIRequestContext, body: Record<string, unknown>) {
  return withRetry(() =>
    r.post(`${FARM_BASE}/api/farm/futures/quote`, {
      headers: { "Content-Type": "application/json" },
      data: body,
    }),
  )
}

function meltQuote(r: APIRequestContext, body: Record<string, unknown>) {
  return withRetry(() =>
    r.post(`${MINT}/v1/melt/quote/future`, {
      headers: { "Content-Type": "application/json" },
      data: { method: "future", request: "farm redemption", ...body },
    }),
  )
}

test.describe("farm API matrix", () => {
  test.describe.configure({ mode: "serial" })

  test.beforeEach(() => {
    if (!PASSWORD && !process.env.PECAN_ADMIN_PASSWORD) {
      test.skip(true, "no farm admin password (fetch via scripts/e2e.sh)")
    }
  })

  test("oracle: series invariants over the whole horizon", async ({ request }) => {
    const data = await overview(request)
    expect(data.series.length).toBeGreaterThan(0)
    const dates = data.series.map((s) => s.date)

    await caseOf(SUITE, "oracle", "dates-unique-and-sorted", { count: dates.length }, async () => {
      const sorted = [...dates].sort()
      expect(dates).toEqual(sorted)
      expect(new Set(dates).size).toBe(dates.length)
      return `${dates.length} series, sorted, unique`
    })

    await caseOf(SUITE, "oracle", "units-encode-their-date", undefined, async () => {
      // The hour is structural (the NUT-32 grammar needs one) and has
      // changed with config (16:00 → 06:00 UTC) — the invariant is the
      // grammar + the DATE, not a fixed hour. The matrix caught the
      // mixed-hour horizon on its first run.
      for (const s of data.series) {
        expect(s.unit).toMatch(new RegExp(`^future:farm-egg:${s.date.replace(/-/g, "")}t[0-9]{6}z$`))
      }
      return "every unit names its date (hour structural)"
    })

    await caseOf(SUITE, "oracle", "capacity-arithmetic-holds", undefined, async () => {
      for (const s of data.series) {
        expect(s.issued + s.redeemed).toBeLessThanOrEqual(s.capacity)
        expect(s.available).toBeLessThanOrEqual(s.capacity - s.issued)
        expect(s.redeemed).toBeLessThanOrEqual(s.issued)
      }
      return "issued+redeemed ≤ cap; available consistent; redeemed ≤ issued"
    })

    await caseOf(SUITE, "oracle", "terms-digests-are-well-formed", undefined, async () => {
      for (const s of data.series) {
        expect(s.terms_sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(s.terms_uri.endsWith(s.terms_sha256)).toBe(true)
      }
      return "sha256 shape + URI suffix match"
    })

    await caseOf(SUITE, "oracle", "today-series-is-collectable", undefined, async () => {
      const today = data.series.find((s) => s.date === isoDate(0))
      expect(today, "a series for today exists").toBeDefined()
      expect(today!.matured).toBe(true)
      return "today reads collectable 24/7"
    })
  })

  test("oracle: per-date endpoints", async ({ request }) => {
    const data = await overview(request)
    const first = data.series[0]

    await caseOf(SUITE, "oracle", "date-oracle-matches-overview", { date: first.date }, async () => {
      const r = await request.get(`${FARM_BASE}/api/farm/${first.date}`)
      expect(r.status()).toBe(200)
      const one = (await r.json()) as Series & { reserved: number }
      expect(one.unit).toBe(first.unit)
      expect(one.capacity).toBe(first.capacity)
      return "per-date oracle agrees"
    })

    for (const bad of ["2030-01-01", "not-a-date", "2026-02-30", ""]) {
      await caseOf(SUITE, "oracle", "unknown-date-refused", { date: bad }, async () => {
        const r = await request.get(`${FARM_BASE}/api/farm/${bad}`)
        expect(r.status()).toBeGreaterThanOrEqual(400)
        return `HTTP ${r.status()}`
      })
    }
  })

  test("terms: content-addressed blobs for every series", async ({ request }) => {
    const data = await overview(request)
    for (const s of data.series) {
      // Terms are IMMUTABLE — the horizon spans eras: hour-16 series
    // predate the day-window/best-effort rounds, hour-06 series carry
    // them. The blob must match its era, and the digest always
    // addresses it.
    const modernTerms = s.unit.includes("t060000z")
    await caseOf(
        SUITE,
        "terms",
        "blob-by-digest",
        { date: s.date, sha: s.terms_sha256.slice(0, 12), era: modernTerms ? "day-window" : "legacy" },
        async () => {
          const r = await request.get(`${FARM_BASE}/terms/${s.terms_sha256}`)
          expect(r.status()).toBe(200)
          const blob = await r.text()
          expect(blob).toContain(s.unit)
          expect(blob).toContain('"shortfall_policy":"issuer-default"')
          // content addressing: the digest IS the address — the served
          // bytes must hash to it exactly
          const digest = createHash("sha256").update(blob).digest("hex")
          expect(digest).toBe(s.terms_sha256)
          if (modernTerms) {
            expect(blob).toContain("claim-it-or-lose-it")
            expect(blob).toContain("best-effort")
          }
          return `${blob.length} bytes, era ${modernTerms ? "day-window" : "legacy"}`
        },
      )
    }
    await caseOf(SUITE, "terms", "malformed-digest-refused", { sha: "zz" }, async () => {
      const r = await request.get(`${FARM_BASE}/terms/zz`)
      expect(r.status()).toBeGreaterThanOrEqual(400)
      return `HTTP ${r.status()}`
    })
  })

  test("mint info: NUT-32 + keysets", async ({ request }) => {
    await caseOf(SUITE, "info", "nut32-advertised", undefined, async () => {
      const info = await request.get(`${MINT}/v1/info`).then((r) => r.json())
      expect(info.nuts?.["32"]).toMatchObject({ supported: true })
      return "NUT-32 v1 advertised"
    })
    await caseOf(SUITE, "info", "keyset-per-series", undefined, async () => {
      const data = await overview(request)
      const keysets = await request
        .get(`${MINT}/v1/keysets`)
        .then((r) => r.json() as Promise<{ keysets: Array<{ id: string; unit: string }> }>)
      for (const s of data.series) {
        expect(
          keysets.keysets.some((k) => k.unit === s.unit),
          `keyset for ${s.unit}`,
        ).toBe(true)
      }
      return `every series unit has a keyset (${keysets.keysets.length} total)`
    })
  })

  test("purchases: valid buys across the horizon", async ({ request }) => {
    for (const offset of [0, 1, 2, 3, 5]) {
      const date = isoDate(offset)
      await caseOf(
        SUITE,
        "buy",
        "valid-buy-per-date",
        { date, offset, qty: 1 },
        async () => {
          const data = await overview(request)
          const s = data.series.find((x) => x.date === date)
          if (!s) return `no series ${date} (horizon edge) — skipped`
          const r = await buyQuote(request, {
            production_date: date,
            quantity: 1,
            pubkey: DUMMY_PUBKEY,
          })
          expect(r.status()).toBe(200)
          const p = (await r.json()) as { purchase_id: string; total_sats: number }
          expect(p.total_sats).toBe(s.price_sats)
          const g = await request.get(`${FARM_BASE}/api/farm/futures/purchase/${p.purchase_id}`)
          expect(g.status()).toBe(200)
          const full = (await g.json()) as { state: string; payment_state: string }
          expect(full.state).toBe("open")
          expect(full.payment_state).toBe("unpaid")
          return `${p.purchase_id.slice(0, 10)} open/unpaid, ${p.total_sats} sat`
        },
      )
    }

    for (const qty of [1, 2, 5, 20]) {
      await caseOf(
        SUITE,
        "buy",
        "valid-buy-per-quantity",
        { qty },
        async () => {
          const r = await buyQuote(request, {
            production_date: isoDate(4),
            quantity: qty,
            pubkey: DUMMY_PUBKEY,
          })
          expect(r.status()).toBe(200)
          const p = (await r.json()) as { total_sats: number }
          expect(p.total_sats).toBe(21 * qty)
          return `${qty} eggs reserved`
        },
      )
    }

    await caseOf(SUITE, "buy", "next-friday-resolver", { qty: 1 }, async () => {
      const r = await buyQuote(request, {
        production_date: "next-friday",
        quantity: 1,
        pubkey: DUMMY_PUBKEY,
      })
      expect(r.status()).toBe(200)
      const p = (await r.json()) as { date: string }
      const data = await overview(request)
      expect(data.series.some((s) => s.date === p.date)).toBe(true)
      return `resolved to ${p.date}`
    })
  })

  test("purchases: invalid quantity shapes", async ({ request }) => {
    const date = isoDate(4)
    const cases: Array<[string, unknown]> = [
      ["zero", 0],
      ["negative", -1],
      ["fractional", 1.5],
      ["string-number", "2"],
      ["huge", 1_000_000_000],
      ["float-overflow", 2 ** 53],
    ]
    for (const [name, qty] of cases) {
      await caseOf(SUITE, "buy-invalid", "quantity-refused", { qty }, async () => {
        const r = await buyQuote(request, { production_date: date, quantity: qty, pubkey: DUMMY_PUBKEY })
        expect(r.status()).toBeGreaterThanOrEqual(400)
        return `HTTP ${r.status()}`
      })
    }
    await caseOf(SUITE, "buy-invalid", "quantity-missing", undefined, async () => {
      const r = await buyQuote(request, { production_date: date, pubkey: DUMMY_PUBKEY })
      expect(r.status()).toBeGreaterThanOrEqual(400)
      return `HTTP ${r.status()}`
    })
  })

  test("purchases: invalid dates", async ({ request }) => {
    for (const [name, date] of [
      ["yesterday", isoDate(-1)],
      ["last-week", isoDate(-7)],
      ["calendar-invalid", "2026-02-30"],
      ["garbage", "eggs-please"],
      ["beyond-horizon", isoDate(60)],
      ["empty", ""],
    ] as Array<[string, string]>) {
      await caseOf(SUITE, "buy-invalid", "date-refused", { date, kind: name }, async () => {
        const r = await buyQuote(request, { production_date: date, quantity: 1, pubkey: DUMMY_PUBKEY })
        expect(r.status()).toBeGreaterThanOrEqual(400)
        return `HTTP ${r.status()}`
      })
    }
  })

  test("purchases: pubkey validation", async ({ request }) => {
    for (const [name, pubkey] of [
      ["missing", undefined],
      ["empty", ""],
      ["not-hex", "zz" + "ab".repeat(31)],
      ["wrong-length", "02ab"],
    ] as Array<[string, string | undefined]>) {
      await caseOf(SUITE, "buy-invalid", "pubkey-refused", { kind: name }, async () => {
        const body: Record<string, unknown> = { production_date: isoDate(4), quantity: 1 }
        if (pubkey !== undefined) body.pubkey = pubkey
        const r = await buyQuote(request, body)
        expect(r.status()).toBeGreaterThanOrEqual(400)
        return `HTTP ${r.status()}`
      })
    }
  })

  test("purchases: capacity edges", async ({ request }) => {
    const data = await overview(request)
    const target =
      [...data.series].reverse().find((s) => s.date > isoDate(0) && s.available >= 1) ??
      data.series.find((s) => s.available >= 1)
    expect(target, "a series with free eggs").toBeDefined()

    await caseOf(
      SUITE,
      "capacity",
      "beyond-capacity-refused",
      { date: target!.date, try: target!.capacity + 1 },
      async () => {
        const r = await buyQuote(request, {
          production_date: target!.date,
          quantity: target!.capacity + 1,
          pubkey: DUMMY_PUBKEY,
        })
        expect(r.status()).toBeGreaterThanOrEqual(400)
        const body = (await r.json()) as { error?: string }
        // Two gates can fire: the per-quantity cap ("quantity must be
        // 1..=N") or the reservation sum ("capacity: … remain").
        expect(body.error ?? "").toMatch(/capacity|quantity must be/)
        return `HTTP ${r.status()} — ${body.error?.slice(0, 40)}`
      },
    )

    await caseOf(
      SUITE,
      "capacity",
      "grab-then-refused",
      { date: target!.date, grab: target!.available },
      async () => {
        if (target!.available < 1) return "nothing free — skipped"
        const grab = await buyQuote(request, {
          production_date: target!.date,
          quantity: target!.available,
          pubkey: DUMMY_PUBKEY,
        })
        expect(grab.status()).toBe(200)
        const next = await buyQuote(request, {
          production_date: target!.date,
          quantity: 1,
          pubkey: DUMMY_PUBKEY,
        })
        expect(next.status()).toBeGreaterThanOrEqual(400)
        return "sold out after grab"
      },
    )
  })

  test("mint quotes: refusals without a wallet-locked purchase", async ({ request }) => {
    const data = await overview(request)
    const today = data.series.find((s) => s.date === isoDate(0))!

    await caseOf(
      SUITE,
      "mint-quote",
      "unknown-purchase-refused",
      { unit: today.unit },
      async () => {
        const r = await request.post(`${MINT}/v1/mint/quote/future`, {
          headers: { "Content-Type": "application/json" },
          data: {
            amount: 1,
            unit: today.unit,
            pubkey: DUMMY_PUBKEY,
            description: "matrix foreign purchase",
            purchase: "does-not-exist",
          },
        })
        expect(r.status()).toBeGreaterThanOrEqual(400)
        return `HTTP ${r.status()}`
      },
    )

    await caseOf(
      SUITE,
      "mint-quote",
      "no-purchase-refused",
      { unit: today.unit },
      async () => {
        const r = await request.post(`${MINT}/v1/mint/quote/future`, {
          headers: { "Content-Type": "application/json" },
          data: { amount: 1, unit: today.unit, pubkey: DUMMY_PUBKEY },
        })
        expect(r.status()).toBeGreaterThanOrEqual(400)
        return `HTTP ${r.status()}`
      },
    )
  })

  test("melt quotes: the day-window and rail enumeration", async ({ request }) => {
    const data = await overview(request)
    const today = data.series.find((s) => s.date === isoDate(0))
    const future = data.series.find((s) => s.date > isoDate(0))
    const past = data.series.find((s) => s.date < isoDate(0))

    if (today) {
      for (const amount of [1, 2, 5]) {
        await caseOf(
          SUITE,
          "melt",
          "today-accepted-any-hour",
          { unit: today.unit, amount },
          async () => {
            const r = await meltQuote(request, { unit: today.unit, amount })
            expect(r.status()).toBe(200)
            const q = (await r.json()) as { quote: string }
            expect(q.quote).toBeTruthy()
            return `quote ${q.quote.slice(0, 10)}`
          },
        )
      }

      for (const [name, body] of [
        ["amount-zero", { unit: today.unit, amount: 0 }],
        ["amount-negative", { unit: today.unit, amount: -2 }],
        ["amount-missing", { unit: today.unit }],
        ["amount-fractional", { unit: today.unit, amount: 1.5 }],
        ["unit-unknown", { unit: "future:farm-egg:20990101t160000z", amount: 1 }],
        ["unit-not-future", { unit: "eur", amount: 1 }],
        ["unit-malformed", { unit: "future:farm-egg:notadate", amount: 1 }],
      ] as Array<[string, Record<string, unknown>]>) {
        await caseOf(SUITE, "melt-invalid", "refused", { kind: name }, async () => {
          const r = await meltQuote(request, body)
          expect(r.status()).toBeGreaterThanOrEqual(400)
          return `HTTP ${r.status()}`
        })
      }
    }

    if (future) {
      await caseOf(
        SUITE,
        "melt-window",
        "future-refused-claim-it-or-lose-it",
        { unit: future.unit, date: future.date },
        async () => {
          const r = await meltQuote(request, { unit: future.unit, amount: 1 })
          expect(r.status()).toBeGreaterThanOrEqual(400)
          const body = await r.text()
          expect(body.toLowerCase()).toMatch(/come back on the day|claim-it-or-lose-it|unsupported/)
          return `HTTP ${r.status()} — future gated`
        },
      )
    }
    if (past) {
      await caseOf(
        SUITE,
        "melt-window",
        "past-refused-claim-lost",
        { unit: past.unit, date: past.date },
        async () => {
          const r = await meltQuote(request, { unit: past.unit, amount: 1 })
          expect(r.status()).toBeGreaterThanOrEqual(400)
          const body = await r.text()
          expect(body.toLowerCase()).toMatch(/claim is lost|claim-it-or-lose-it|unsupported/)
          return `HTTP ${r.status()} — past gated`
        },
      )
    }
  })

  test("melt rails: virtual routes, others refuse", async ({ request }) => {
    const data = await overview(request)
    const today = data.series.find((s) => s.date === isoDate(0))
    if (!today) return

    await caseOf(
      SUITE,
      "rail",
      "virtual-envelope-accepted",
      { unit: today.unit, request: "virtual:screen" },
      async () => {
        const r = await request.post(`${MINT}/v1/melt/quote/future`, {
          headers: { "Content-Type": "application/json" },
          data: { method: "future", request: "virtual:screen", unit: today.unit, amount: 1 },
        })
        expect(r.status()).toBe(200)
        return "virtual quote created"
      },
    )

    // Matrix finding (2026-09-20): "virtual:" (empty destination) does
    // NOT parse as an envelope — the melt silently becomes counter
    // mode. Pinned as-is; a strict-wallet that intends virtual must
    // send a destination.
    await caseOf(
      SUITE,
      "rail",
      "virtual-empty-destination-degrades-to-counter",
      { request: "virtual:" },
      async () => {
        const login = await request.post(`${FARM_BASE}/api/login`, {
          headers: { "Content-Type": "application/json" },
          data: { username: "admin", password: PASSWORD || process.env.PECAN_ADMIN_PASSWORD },
        })
        expect(login.status()).toBe(200)
        const r = await request.post(`${MINT}/v1/melt/quote/future`, {
          headers: { "Content-Type": "application/json" },
          data: { method: "future", request: "virtual:", unit: today.unit, amount: 1 },
        })
        expect(r.status()).toBe(200)
        const q = (await r.json()) as { quote: string }
        const match = await request.post(`${FARM_BASE}/api/quotes/match`, {
          headers: { "Content-Type": "application/json" },
          data: { code: q.quote.slice(-6).toUpperCase() },
        })
        const t = (await match.json()) as { payout_rail?: string }
        expect(t.payout_rail).toBe("farm")
        return "empty envelope → counter rail (pinned)"
      },
    )

    for (const rail of ["sim:ALIAS", "sepa:NL33INGB0000000881", "ln:lnbc1x", "btc:bc1qx"]) {
      await caseOf(SUITE, "rail", "non-virtual-rail-refused", { rail }, async () => {
        const r = await request.post(`${MINT}/v1/melt/quote/future`, {
          headers: { "Content-Type": "application/json" },
          data: { method: "future", request: rail, unit: today.unit, amount: 1 },
        })
        expect(r.status()).toBeGreaterThanOrEqual(400)
        return `HTTP ${r.status()} — futures only exit virtually`
      })
    }

    // The rail must reach the TICKET: admin can see payout_rail=virtual.
    await caseOf(
      SUITE,
      "rail",
      "virtual-ticket-created",
      { unit: today.unit },
      async () => {
        const login = await request.post(`${FARM_BASE}/api/login`, {
          headers: { "Content-Type": "application/json" },
          data: { username: "admin", password: PASSWORD || process.env.PECAN_ADMIN_PASSWORD },
        })
        expect(login.status()).toBe(200)
        const r = await request.post(`${MINT}/v1/melt/quote/future`, {
          headers: { "Content-Type": "application/json" },
          data: { method: "future", request: "virtual:screen", unit: today.unit, amount: 1 },
        })
        expect(r.status()).toBe(200)
        const q = (await r.json()) as { quote: string }
        // the ticket waits for the wallet to lock funds — visible via match
        const match = await request.post(`${FARM_BASE}/api/quotes/match`, {
          headers: { "Content-Type": "application/json" },
          data: { code: q.quote.slice(-6).toUpperCase() },
        })
        expect(match.status()).toBe(200)
        const t = (await match.json()) as { payout_rail?: string; status?: string }
        expect(t.payout_rail).toBe("virtual")
        return `ticket rail=virtual status=${t.status}`
      },
    )
  })

  test("one-way invariant: futures never melt to sats", async ({ request }) => {
    const data = await overview(request)
    const today = data.series.find((s) => s.date === isoDate(0))
    if (!today) return
    for (const method of ["ln", "btc", "bolt11"]) {
      await caseOf(SUITE, "one-way", "sats-exit-refused", { method }, async () => {
        const r = await request.post(`${MINT}/v1/melt/quote/${method}`, {
          headers: { "Content-Type": "application/json" },
          data: { method, request: "lnbc1placeholder", unit: today.unit, amount: 1 },
        })
        expect(r.status()).toBeGreaterThanOrEqual(400)
        return `HTTP ${r.status()}`
      })
    }
  })

  test("concurrency: parallel buys within capacity", async ({ request }) => {
    const data = await overview(request)
    const target = [...data.series].reverse().find((s) => s.date > isoDate(0) && s.available >= 8)
    if (!target) {
      test.skip(true, "no future day with 8+ free eggs")
      return
    }
    await caseOf(
      SUITE,
      "concurrency",
      "eight-parallel-buys-all-land",
      { date: target.date, qty: 1, parallel: 8 },
      async () => {
        const rs = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            buyQuote(request, {
              production_date: target.date,
              quantity: 1,
              pubkey: "02" + (i + 1).toString(16).padStart(2, "0") + "ab".repeat(31),
            }),
          ),
        )
        for (const [i, r] of rs.entries()) {
          expect(r.status(), `buy ${i}: ${(await r.text()).slice(0, 120)}`).toBe(200)
        }
        const after = await overview(request)
        const s = after.series.find((x) => x.date === target.date)
        expect(s!.available).toBe(target.available - 8)
        return "8/8 reserved atomically"
      },
    )
  })
})
