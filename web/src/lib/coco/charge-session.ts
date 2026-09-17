/**
 * Deposit-pattern charge session accounting (docs/partial-delivery.md).
 * The session receipt is the session record: EV-<device>-<kWs>s-<hex>
 * with a -STOPPED suffix when the device or the wallet ended it early.
 *
 * Energy pricing (#30 layer B): the tariff is currency units per kWh
 * and the billed quantity is the car's METERED kW·s (1 kWh = 3600 kW·s),
 * so delivered energy maps to spent cents and the unspent deposit is
 * the refund the wallet claims.
 *
 * PRICE_PER_KWH mirrors the ev-charge daemons' --eur-per-kwh ExecStart
 * flag on every pair (100 units/kWh: 1 unit = 36 kW·s). It is a demo
 * value, not a real-world one: the mint's 1-unit minimum melt and the
 * gateway's 3600 kW·s session cap make a ~0.50/kWh price impossible
 * until sub-unit melts exist (tracked on #30). Charger specs pin this
 * constant against the deployment — change them together.
 */

export const PRICE_PER_KWH = 0.5

/** Cost in cents of delivered metered kW·s at the given tariff. */
export function kwsToCostCents(kws: number, pricePerKwh = PRICE_PER_KWH): number {
  return Math.round((kws * pricePerKwh) / 36)
}

/**
 * Cents claimable back from a deposit: the melt minus the metered cost,
 * floored at zero and capped at the budget. Refund quotes are mint
 * quotes subject to the mint's 1-unit (100-cent) minimum, so smaller
 * remainders stay unclaimed (rounding exposure, at most one cent).
 */
export function refundCents(
  budgetCents: number,
  deliveredKws: number,
  pricePerKwh = PRICE_PER_KWH,
): number {
  const spent = Math.min(budgetCents, kwsToCostCents(deliveredKws, pricePerKwh))
  const refund = budgetCents - spent
  if (refund < 100) return 0
  return Math.min(budgetCents, refund)
}

export interface ChargeReceipt {
  device: string
  deliveredSeconds: number
  stopped: boolean
}

export function parseChargeReceipt(receipt: string): ChargeReceipt | null {
  const m = receipt.match(/^EV-([A-Za-z0-9_-]+)-(\d+)s-[0-9A-F]{8}(-STOPPED)?$/)
  if (!m) return null
  return {
    device: m[1]!,
    deliveredSeconds: Number(m[2]),
    stopped: Boolean(m[3]),
  }
}
