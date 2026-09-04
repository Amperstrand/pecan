import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CURRENCIES,
  activeCurrency,
  consoleUrl,
  currencyOfMint,
  mintUrl,
  setActiveCurrency,
} from "./currency"

// The registry reads window.location and localStorage — stub the minimum.
function stubWindow(origin = "https://giftcard.cashu.exchange") {
  const store = new Map<string, string>()
  const windowStub = {
    location: { origin },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  }
  vi.stubGlobal("window", windowStub)
  return store
}

describe("currency registry", () => {
  beforeEach(() => stubWindow())
  afterEach(() => vi.unstubAllGlobals())

  it("fiat pairs map to the {currency}/v1 and {currency}-console convention", () => {
    expect(mintUrl("eur")).toBe("https://giftcard.cashu.exchange/eur")
    expect(mintUrl("usd")).toBe("https://giftcard.cashu.exchange/usd")
    expect(consoleUrl("eur")).toBe("https://giftcard.cashu.exchange/eur-console")
    expect(consoleUrl("usd")).toBe("https://giftcard.cashu.exchange/usd-console")
    for (const [code, cfg] of Object.entries(CURRENCIES)) {
      if (!cfg.hasRails) continue
      expect(mintUrl(code as "eur")).toBe(
        `https://giftcard.cashu.exchange${cfg.mintPath}`,
      )
      expect(cfg.mintPath).toMatch(/^\/[a-z]+$/)
      expect(cfg.consolePath).toBe(`${cfg.mintPath}-console`)
    }
  })

  it("sat is the external single mint: different origin, no console, whole-unit scale", () => {
    // The user's explicit design: single-mint sats on signut, no multimint.
    expect(mintUrl("sat")).toBe("https://signut.cashu.exchange")
    expect(consoleUrl("sat")).toBeUndefined()
    expect(CURRENCIES.sat.scale).toBe(1)
    expect(CURRENCIES.sat.step).toBe("1")
    expect(CURRENCIES.sat.hasRails).toBe(false)
    expect(currencyOfMint("https://signut.cashu.exchange")).toBe("sat")
  })

  it("defaults to eur and round-trips the persisted choice", () => {
    expect(activeCurrency()).toBe("eur")
    setActiveCurrency("usd")
    expect(activeCurrency()).toBe("usd")
    setActiveCurrency("eur")
    expect(activeCurrency()).toBe("eur")
  })

  it("falls back to eur for corrupted storage", () => {
    window.localStorage.setItem("pecan-currency", "nok")
    expect(activeCurrency()).toBe("eur")
  })

  it("round-trips mint URLs back to currencies", () => {
    for (const code of Object.keys(CURRENCIES)) {
      expect(currencyOfMint(mintUrl(code as "eur"))).toBe(code)
    }
    expect(currencyOfMint("https://other.mint.example")).toBeUndefined()
  })
})
