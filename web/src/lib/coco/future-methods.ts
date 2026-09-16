import type { UnitAmount } from "@cashu/coco-core"
import type {} from "@cashu/coco-core/operations/mint"
import type {} from "@cashu/coco-core/operations/melt"
import type { AmountLike, MeltQuoteBaseResponse, MintQuoteBaseResponse } from "@cashu/cashu-ts"

/**
 * NUT-32 (draft) future methods: issuance rides the `future` mint method
 * (a NUT-20-locked quote referencing a paid farm purchase), redemption
 * rides the `future` melt method (a teller ticket settled against physical
 * handover). Proof secrets carry the future tag with the terms URI.
 */
export interface FutureMintQuoteResponse extends MintQuoteBaseResponse {
  amount?: AmountLike
}

export interface FutureMeltQuoteResponse extends MeltQuoteBaseResponse {
  payment_preimage?: string | null
}

declare module "@cashu/coco-core/operations/mint" {
  interface MintMethodDefinitions {
    future: {
      methodData: Record<string, never>
      createQuoteData: {
        amount: UnitAmount
        description?: string
        locked?: boolean
      }
      quoteData: { amount: AmountLike; request: string }
      remoteState: "UNPAID" | "PAID" | "ISSUED"
      quote: FutureMintQuoteResponse
    }
  }
}

declare module "@cashu/coco-core/operations/melt" {
  interface MeltMethodInputDefinitions {
    future: { amount: AmountLike; description?: string }
  }
  interface MeltMethodDefinitions {
    future: { amount: AmountLike; description?: string }
  }
  interface MeltMethodQuoteDefinitions {
    future: FutureMeltQuoteResponse
  }
}

export const FUTURE_METHOD = "future" as const

/**
 * Parse the NUT-10 future tag out of a proof secret
 * (`{"secret":…,"tags":[["future","1","<uri>"]]}`), if present.
 */
export function futureTagOfSecret(secret: string): { version: string; termsUri: string } | null {
  try {
    const parsed = JSON.parse(secret) as { tags?: unknown[][] }
    if (!Array.isArray(parsed.tags)) return null
    const tags = parsed.tags.filter(
      (t): t is string[] => Array.isArray(t) && t[0] === "future" && t.length === 3,
    )
    if (tags.length !== 1) return null
    return { version: tags[0][1], termsUri: tags[0][2] }
  } catch {
    return null
  }
}

export function isFutureUnit(unit: string): boolean {
  return unit.startsWith("future:")
}
