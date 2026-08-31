// Multi-currency registry: each currency is a full (mintd + pecan) pair
// behind this one origin (issue #4). EUR owns the root paths — existing
// proofs and mint URLs must never move; later currencies get path prefixes
// that caddy strips before proxying to their stack:
//   {origin}/v1/*           -> mintd-eur :8089     (console at /console/*)
//   {origin}/usd/v1/*       -> mintd-usd :8097     (console at /usd-console/*)
// The customer wallet talks to mint URLs directly; pecan-scoped endpoints
// (onchain-status, teller login) use the console path per currency.

export type Currency = "eur" | "usd"

export interface CurrencyConfig {
  /** Mint URL path prefix ("" = root). */
  mintPath: string
  /** Pecan console path prefix ("" = root console). */
  consolePath: string
  symbol: string
  label: string
}

export const CURRENCIES: Record<Currency, CurrencyConfig> = {
  eur: { mintPath: "", consolePath: "", symbol: "€", label: "EUR" },
  usd: { mintPath: "/usd", consolePath: "/usd-console", symbol: "$", label: "USD" },
}

const ACTIVE_KEY = "pecan-currency"

export function activeCurrency(): Currency {
  if (typeof window === "undefined") return "eur"
  const stored = window.localStorage.getItem(ACTIVE_KEY)
  return stored === "usd" || stored === "eur" ? stored : "eur"
}

export function setActiveCurrency(currency: Currency): void {
  window.localStorage.setItem(ACTIVE_KEY, currency)
}

export function mintUrl(currency: Currency = activeCurrency()): string {
  return window.location.origin + CURRENCIES[currency].mintPath
}

/** Base URL for this currency's pecan console API ("" prefix = same origin root). */
export function consoleUrl(currency: Currency = activeCurrency()): string {
  return window.location.origin + CURRENCIES[currency].consolePath
}

export function currencyOfMint(url: string): Currency | undefined {
  const normalized = url.replace(/\/$/, "")
  return (Object.keys(CURRENCIES) as Currency[]).find(
    (c) => mintUrl(c) === normalized,
  )
}
