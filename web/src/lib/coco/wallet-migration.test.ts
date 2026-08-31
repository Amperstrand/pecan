import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { remapKey } from "./wallet-migration"

function stubWindow() {
  const store = new Map<string, string>()
  vi.stubGlobal("window", {
    location: { origin: "https://giftcard.cashu.exchange" },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  })
  return store
}

// cancelDepositQuote is imported lazily-style to keep the stub active
// through module evaluation of coco-wallet (it reads no window state at
// import time, so a plain import also works — keep it plain).
import { cancelDepositQuote } from "./coco-wallet"

describe("legacy mint URL key remapping", () => {
  it("remaps scalar keys and compound keys carrying the legacy URL first", () => {
    const from = "https://giftcard.cashu.exchange"
    const to = "https://giftcard.cashu.exchange/eur"
    expect(remapKey(from, from, to)).toBe(to)
    expect(remapKey([from, "keyset-1"], from, to)).toEqual([to, "keyset-1"])
    expect(remapKey([from, "abc", "def"], from, to)).toEqual([to, "abc", "def"])
  })

  it("leaves keys that do not embed the legacy URL alone", () => {
    const from = "https://giftcard.cashu.exchange"
    const to = "https://giftcard.cashu.exchange/eur"
    expect(remapKey("op-123", from, to)).toBeNull()
    expect(remapKey(["https://other.mint", "k"], from, to)).toBeNull()
    expect(remapKey(42, from, to)).toBeNull()
  })
})

describe("deposit cancel tombstones", () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = stubWindow()
  })
  afterEach(() => vi.unstubAllGlobals())

  it("persists the cancelled quote id, deduped and capped", () => {
    cancelDepositQuote("quote-a")
    cancelDepositQuote("quote-b")
    cancelDepositQuote("quote-a") // dedupe moves it to the front
    const list = JSON.parse(
      store.get("pecan-cancelled-quotes") as string,
    ) as string[]
    expect(list).toEqual(["quote-a", "quote-b"])

    for (let i = 0; i < 60; i++) cancelDepositQuote(`noise-${i}`)
    const capped = JSON.parse(
      store.get("pecan-cancelled-quotes") as string,
    ) as string[]
    expect(capped).toHaveLength(50)
    expect(capped).not.toContain("quote-b")
  })
})
