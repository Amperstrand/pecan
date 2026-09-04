// Multi-currency registry. EUR and USD are our own (mintd + pecan) pairs
// behind this one origin (issue #4), path convention {currency}/v1/* for
// the mint and {currency}-console/* for its pecan. SAT is different: it
// is an EXTERNAL single mint (signut.cashu.exchange, signet-backed,
// bolt11-only) — no pecan pair, no console, no teller rails; its
// deposit/withdraw are the native Cashu bolt11 flows.
//   {origin}/eur/v1/*  -> mintd-eur :8089   (console /eur-console/*)
//   {origin}/usd/v1/*  -> mintd-usd :8097   (console /usd-console/*)
//   https://signut.cashu.exchange -> nutshell-cf mint, unit sat
// The customer wallet talks to mint URLs directly; pecan-scoped endpoints
// (onchain-status, teller login) use the console path per currency.

export type Currency = "eur" | "usd" | "sat"

export interface CurrencyConfig {
  /**
   * Full mint URL. Same-origin pairs derive from window.location.origin +
   * mintPath; the sat mint is a different origin entirely (CORS is open:
   * access-control-allow-origin * — verified 2026-09-04).
   */
  mintUrl: string
  /** Same-origin path prefix ("" = root) — unused for external mints. */
  mintPath: string
  /** Pecan console path prefix — undefined when the currency has no pecan. */
  consolePath: string | undefined
  symbol: string
  label: string
  /** Balance display divisor: 100 for cent-based fiat, 1 for sats. */
  scale: number
  /** Smallest whole-unit step the UI accepts ("0.01" vs "1"). */
  step: string
  /** Whether this currency has pecan rails (teller + payout rails). */
  hasRails: boolean
}

const ORIGIN = () =>
  typeof window !== "undefined" ? window.location.origin : ""

export const CURRENCIES: Record<Currency, CurrencyConfig> = {
  eur: {
    mintUrl: "",
    mintPath: "/eur",
    consolePath: "/eur-console",
    symbol: "€",
    label: "EUR",
    scale: 100,
    step: "0.01",
    hasRails: true,
  },
  usd: {
    mintUrl: "",
    mintPath: "/usd",
    consolePath: "/usd-console",
    symbol: "$",
    label: "USD",
    scale: 100,
    step: "0.01",
    hasRails: true,
  },
  sat: {
    // External single mint (the user's explicit choice: single-mint sats,
    // no multimint). Signet play-money exactly like our EUR/USD — the
    // unit enum "sat" is the Cashu-ecosystem name (NUT-02 UNIT).
    mintUrl: "https://signut.cashu.exchange",
    mintPath: "",
    consolePath: undefined,
    symbol: "sat",
    label: "SATS",
    scale: 1,
    step: "1",
    hasRails: false,
  },
}

const ACTIVE_KEY = "pecan-currency"

export function activeCurrency(): Currency {
  if (typeof window === "undefined") return "eur"
  const stored = window.localStorage.getItem(ACTIVE_KEY)
  return stored === "usd" || stored === "sat" || stored === "eur" ? stored : "eur"
}

export function setActiveCurrency(currency: Currency): void {
  window.localStorage.setItem(ACTIVE_KEY, currency)
}

/** Full mint URL — lazily resolved so tests can stub window post-import. */
export function mintUrl(currency: Currency = activeCurrency()): string {
  const cfg = CURRENCIES[currency]
  return cfg.mintUrl === "" ? ORIGIN() + cfg.mintPath : cfg.mintUrl
}

/** Base URL for this currency's pecan console API — undefined for sat. */
export function consoleUrl(currency: Currency = activeCurrency()): string | undefined {
  const path = CURRENCIES[currency].consolePath
  return path === undefined ? undefined : ORIGIN() + path
}

export function currencyOfMint(url: string): Currency | undefined {
  const normalized = url.replace(/\/$/, "")
  return (Object.keys(CURRENCIES) as Currency[]).find(
    (c) => mintUrl(c) === normalized,
  )
}
