import { test } from "@playwright/test"

// Warm the film devices' persistent wallets (one full buy → transfer →
// virtual-redeem cycle each, off camera) and leave a marker. The first
// cycle can take ~30 minutes (cold op paths crawl); retakes skip this.
// Run via scripts/portal-movie.sh (pass "warm") or directly.

test("warm the portal film devices", async () => {
  test.setTimeout(3_600_000)
  const overview = (await (await fetch("https://giftcard.cashu.exchange/farm-console/api/farm")).json()) as {
    series: Array<{ date: string; unit: string; available: number }>
  }
  const today = new Date().toISOString().slice(0, 10)
  const series = overview.series.find((s) => s.date === today && s.available >= 4)
  if (!series) throw new Error("today's eggs are sold out (need 4: 2 warm-up + 2 film)")
  await import("./portal-film-lib").then((m) => m.ensureWarm(series.unit))
})
