/**
 * Deposit-pattern charge session accounting (docs/partial-delivery.md).
 * The session receipt is the session record: EV-<device>-<seconds>s-<hex>
 * with a -STOPPED suffix when the device or the wallet ended it early.
 * The tariff is seconds-per-euro, so delivered seconds map linearly to
 * spent euros and the unspent deposit is the refund the wallet claims.
 */

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

/**
 * Whole euros claimable back from a deposit. Refund quotes are mint
 * quotes and subject to the mint's €1 minimum, so sub-euro remainders
 * stay unclaimed (rounding exposure, at most one tariff unit).
 */
export function refundEuros(
  budgetEuros: number,
  deliveredSeconds: number,
  secsPerEur = 1,
): number {
  const spent = deliveredSeconds / secsPerEur
  const refund = Math.floor(budgetEuros - spent)
  return Math.max(0, Math.min(budgetEuros, refund))
}
