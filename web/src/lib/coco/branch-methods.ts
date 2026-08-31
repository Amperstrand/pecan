import type {
  Amount,
  AmountLike,
  MeltQuoteBaseResponse,
  MintQuoteBaseResponse,
} from "@cashu/cashu-ts"
import type { UnitAmount } from "@cashu/coco-core"

import type {} from "@cashu/coco-core/operations/melt"
import type {} from "@cashu/coco-core/operations/mint"

export interface BranchMeltQuoteResponse extends MeltQuoteBaseResponse {
  payment_preimage?: string | null
}

export interface BranchMintQuoteResponse extends MintQuoteBaseResponse {
  amount?: AmountLike
  /** onchain rail: the sats the payer must send (flattened extra field). */
  expected_sat?: number
}

declare module "@cashu/coco-core/operations/melt" {
  interface MeltMethodInputDefinitions {
    branch: { amount: Amount; description?: string }
  }
  interface MeltMethodDefinitions {
    branch: { amount: Amount; description?: string }
  }
  interface MeltMethodQuoteDefinitions {
    branch: BranchMeltQuoteResponse
  }
}

declare module "@cashu/coco-core/operations/mint" {
  interface MintMethodDefinitions {
    branch: {
      methodData: Record<string, never>
      createQuoteData: {
        amount: UnitAmount
        description?: string
        locked?: boolean
      }
      quoteData: { amount: Amount; request: string }
      remoteState: "UNPAID" | "PAID" | "ISSUED"
      quote: BranchMintQuoteResponse
    }
    ln: {
      methodData: Record<string, never>
      createQuoteData: {
        amount: UnitAmount
        description?: string
        locked?: boolean
      }
      quoteData: { amount: Amount; request: string }
      remoteState: "UNPAID" | "PAID" | "ISSUED"
      quote: BranchMintQuoteResponse
    }
    btc: {
      methodData: Record<string, never>
      createQuoteData: {
        amount: UnitAmount
        description?: string
        locked?: boolean
      }
      quoteData: { amount: Amount; request: string; expected_sat?: number }
      remoteState: "UNPAID" | "PAID" | "ISSUED"
      quote: BranchMintQuoteResponse
    }
  }
}

export const BRANCH_METHOD = "branch" as const
export const LN_METHOD = "ln" as const
export type DepositMethod = "branch" | "ln" | "btc"
// Multi-currency: see ./currency.ts — mint URL and unit derive from the
// active currency; these legacy exports remain for the classic wallet.
export const MINT_URL = (): string => window.location.origin
export const UNIT = "eur"
