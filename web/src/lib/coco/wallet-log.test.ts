import { describe, expect, it } from "vitest"
import { getWalletLog, walletLog, type WalletLogEntry } from "./wallet-log"

// The ring buffer is the suite's failure forensics: every e2e test gates
// on its contents (warn-free per test, fund-lock entries present). Its
// bounding and serialization are money-adjacent — a lost entry hides the
// exact warn that explains a drift.

describe("walletLog ring buffer", () => {
  it("appends entries in order with level and data", () => {
    walletLog("info", "first", { n: 1 })
    walletLog("warn", "second", { n: 2 })
    const log = getWalletLog()
    const tail = log.slice(-2)
    expect(tail.map((e) => e.msg)).toEqual(["first", "second"])
    expect(tail[0]!.level).toBe("info")
    expect(tail[1]!.data).toEqual({ n: 2 })
  })

  it("serializes bigint data (JSON-unsafe in the ring)", () => {
    walletLog("info", "bigint", { sat: 1024n })
    const entry = getWalletLog().at(-1) as WalletLogEntry
    expect(entry.data).toEqual({ sat: "1024" })
  })

  it("survives JSON round-tripping (the e2e attachment path)", () => {
    walletLog("info", "roundtrip", { t: 123, s: "x" })
    const entry = getWalletLog().at(-1)!
    const revived = JSON.parse(JSON.stringify(entry))
    expect(revived.msg).toBe("roundtrip")
    expect(revived.data.t).toBe(123)
  })

  it("bounds the buffer: oldest entries drop beyond the cap", () => {
    const before = getWalletLog().length
    const cap = 400
    const fill = cap + 50
    for (let i = 0; i < fill; i++) walletLog("info", `fill-${i}`, null)
    const log = getWalletLog()
    expect(log.length).toBeLessThanOrEqual(cap)
    // The NEWEST entries survive; the oldest of the fill are gone.
    expect(log.at(-1)!.msg).toBe(`fill-${fill - 1}`)
    const firstSurvivor = Number(log[0]!.msg.split("-")[1])
    expect(firstSurvivor).toBeGreaterThanOrEqual(fill - cap)
    expect(before).toBeLessThanOrEqual(log.length)
  })
})
