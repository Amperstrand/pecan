import { pollRedemption, startRedemption } from "./farm"

export type RedemptionUpdate =
  | { kind: "waiting"; tail: string }
  | { kind: "receipt"; receipt: string }
  | { kind: "failed" }
  | { kind: "timeout" }

export type RedemptionOutcome = "receipt" | "failed" | "timeout"

const POLL_MS = 2500
const WAIT_BUDGET_MS = 10 * 60_000

/**
 * One redemption flow, shared by the wallet's FARM panel and the claims
 * portal (kiosk) — both are customer-side faces of the same teller
 * ticket: lock the proofs into a `future` melt quote, show the teller
 * code, then poll until the operator's settle lands as a FARM receipt.
 * The mint burns nothing before the operator settles, so every terminal
 * outcome leaves the wallet whole (receipt) or restores the proofs.
 */
export async function runFarmRedemption(
  unit: string,
  quantity: number,
  onUpdate: (update: RedemptionUpdate) => void,
): Promise<RedemptionOutcome> {
  const start = await startRedemption(unit, quantity)
  onUpdate({ kind: "waiting", tail: start.tail })
  const deadline = Date.now() + WAIT_BUDGET_MS
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const result = await pollRedemption(start.quoteId).catch(() => null)
    if (result === "FAILED") {
      onUpdate({ kind: "failed" })
      return "failed"
    }
    if (result) {
      onUpdate({ kind: "receipt", receipt: result })
      return "receipt"
    }
    if (Date.now() > deadline) {
      onUpdate({ kind: "timeout" })
      return "timeout"
    }
  }
}
