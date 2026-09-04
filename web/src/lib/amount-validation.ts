// Amount limits shared by the deposit/withdraw forms. The mint enforces
// 1–1000 (min_mint=100 / max_mint=100000 cents) server-side; these
// validators make the same rules visible client-side instead of failing
// silently (typing 1231234 used to do nothing at all).

export type DepositRail = "branch" | "ln" | "btc"

export const MIN_AMOUNT = 1
export const MAX_AMOUNT = 1000
/** On-chain deposits must cover dust + fees (mint's MIN_ONCHAIN_ORE). */
export const MIN_ONCHAIN_DEPOSIT = 50
/** Sats (signut): whole-unit amounts, the mint caps at 100k sat. */
export const MIN_SAT = 1
export const MAX_SAT = 100000

/**
 * Validate a deposit amount for a rail. Returns a user-facing error
 * message, or null when the amount is acceptable.
 */
export function validateDepositAmount(
  raw: string,
  rail: DepositRail,
  symbol: string,
  isSat = false,
): string | null {
  const amount = Number.parseFloat(raw)
  if (!Number.isFinite(amount) || amount <= 0) {
    return `Enter an amount in ${symbol}.`
  }
  if (isSat) {
    if (!Number.isInteger(amount)) {
      return "Sats amounts are whole numbers."
    }
    if (amount > MAX_SAT) {
      return `Amounts above ${MAX_SAT.toLocaleString()} ${symbol} are not supported (mint limit).`
    }
    return null
  }
  const min = rail === "btc" ? MIN_ONCHAIN_DEPOSIT : MIN_AMOUNT
  if (amount < min) {
    return rail === "btc"
      ? `On-chain deposits must be at least ${min} ${symbol} — they pay for dust and chain fees.`
      : `Deposits must be at least ${min} ${symbol}.`
  }
  if (amount > MAX_AMOUNT) {
    return `Amounts above ${MAX_AMOUNT} ${symbol} are not supported (mint limit).`
  }
  return null
}

/**
 * Validate a withdraw amount. `balanceCents` is the wallet balance in
 * cents (null = not loaded yet — the server still rejects overspending).
 */
export function validateWithdrawAmount(
  raw: string,
  symbol: string,
  balanceCents: number | null,
  isSat = false,
): string | null {
  const amount = Number.parseFloat(raw)
  if (!Number.isFinite(amount) || amount <= 0) {
    return `Enter an amount in ${symbol}.`
  }
  if (isSat) {
    if (!Number.isInteger(amount)) {
      return "Sats amounts are whole numbers."
    }
    if (amount > MAX_SAT) {
      return `Amounts above ${MAX_SAT.toLocaleString()} ${symbol} are not supported (mint limit).`
    }
    if (balanceCents !== null && amount > balanceCents) {
      return `Amount exceeds your balance (${balanceCents.toLocaleString()} ${symbol}).`
    }
    return null
  }
  if (amount < MIN_AMOUNT) {
    return `Withdrawals must be at least ${MIN_AMOUNT} ${symbol}.`
  }
  if (amount > MAX_AMOUNT) {
    return `Amounts above ${MAX_AMOUNT} ${symbol} are not supported (mint limit).`
  }
  if (balanceCents !== null && amount > balanceCents / 100) {
    return `Amount exceeds your balance (${(balanceCents / 100).toFixed(2)} ${symbol}).`
  }
  return null
}
