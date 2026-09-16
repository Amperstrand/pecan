import { Amount, MintOperationError, type Proof, type SerializedBlindedSignature } from "@cashu/cashu-ts"
import {
  BaseQuoteMeltHandler,
  type BoltMeltQuote,
  type BoltMeltQuoteState,
  type QuoteMeltResponse,
} from "@cashu/coco-core"
import type {
  BasePrepareContext,
  CreateMeltQuoteContext,
  ExecuteContext,
  FetchRemoteMeltQuoteContext,
  FinalizeContext,
  PendingContext,
  RecoverExecutingContext,
} from "@cashu/coco-core/operations/melt"
import type { FutureMeltQuoteResponse } from "./future-methods"

function proofsToSerializedChange(proofs: Proof[]): SerializedBlindedSignature[] | undefined {
  if (proofs.length === 0) return undefined
  return proofs.map((p) => ({ id: p.id, amount: p.amount, C_: p.C }))
}

/**
 * Redemption melt for NUT-32 futures: burn future proofs at the counter —
 * the operator hands over physical eggs and settles the teller ticket;
 * the FARM receipt comes back as the preimage analogue. Same eager-lock
 * contract as the teller rail: the farm may only hand eggs over once the
 * wallet has locked (burned) its proofs.
 */
export class MeltFutureHandler extends BaseQuoteMeltHandler<"future"> {
  protected readonly method = "future" as const

  needsSwapFor(selectedAmount: Amount, _totalAmount: Amount): boolean {
    // Future keysets carry no input fee; still swap on any overshoot so
    // the melt is exact (change-less) and the unit's terms-tagged secrets
    // stay the only thing in flight.
    return false
  }

  protected async createRemoteQuote(
    ctx: CreateMeltQuoteContext<"future">,
  ): Promise<FutureMeltQuoteResponse> {
    // NUT #5: For a custom `{method}`, the wallet sends a request following the common melt quote request format (see [General Flow](#general-flow)). The `request` field is the method-specific payment target.
    return ctx.wallet.createMeltQuote<FutureMeltQuoteResponse>("future", {
      method: "future",
      request: ctx.methodData.description ?? "farm redemption",
      unit: ctx.unit,
      amount: ctx.methodData.amount,
    })
  }

  protected async fetchRemoteMeltQuote(
    ctx: FetchRemoteMeltQuoteContext<"future">,
  ): Promise<FutureMeltQuoteResponse> {
    return ctx.mintAdapter.checkMeltQuoteFor(ctx.quote.mintUrl, "future", ctx.quote.quoteId)
  }

  protected async executeMelt(
    ctx: ExecuteContext<"future">,
    proofsToMelt: Proof[],
    changeOutputs: Parameters<BaseQuoteMeltHandler<"future">["executeMelt"]>[2],
    quoteId: string,
  ): Promise<QuoteMeltResponse<"future">> {
    const preview = {
      method: "future",
      inputs: proofsToMelt,
      outputData: changeOutputs,
      keysetId: proofsToMelt[0]?.id ?? "",
      quote: {
        quote: quoteId,
        amount: ctx.operation.amount,
      },
    } as Parameters<typeof ctx.wallet.completeMelt>[0]
    try {
      const res = await ctx.wallet.completeMelt(preview, undefined, {
        preferAsync: true,
      })
      const q = res.quote as { state?: string; payment_preimage?: string | null }
      if (q.state !== "PAID" && q.state !== "PENDING" && q.state !== "UNPAID") {
        throw new Error(`redemption refused by mint: state ${JSON.stringify(q.state ?? null)}`)
      }
      return {
        state: q.state,
        change: proofsToSerializedChange(res.change),
        payment_preimage: q.payment_preimage,
      }
    } catch (err) {
      if (err instanceof MintOperationError && err.code === 20005) {
        return { state: "PENDING" }
      }
      throw err
    }
  }

  protected async checkMeltQuote(
    ctx: FinalizeContext<"future"> | RecoverExecutingContext<"future">,
  ): Promise<QuoteMeltResponse<"future">> {
    const q = await ctx.mintAdapter.checkMeltQuoteFor(
      ctx.operation.mintUrl,
      "future",
      ctx.operation.quoteId,
    )
    return {
      state: q.state,
      change: q.change as SerializedBlindedSignature[] | undefined,
      payment_preimage: q.payment_preimage,
    }
  }

  protected async checkMeltQuoteState(
    ctx: PendingContext<"future"> | RecoverExecutingContext<"future">,
  ): Promise<BoltMeltQuoteState> {
    const q = await ctx.mintAdapter.checkMeltQuoteFor(
      ctx.operation.mintUrl,
      "future",
      ctx.operation.quoteId,
    )
    return q.state
  }

  protected getFeeReserveForQuote(
    quote: FutureMeltQuoteResponse,
    _operation: BasePrepareContext<"future">["operation"],
  ): Amount {
    return Amount.from(quote.fee_reserve ?? 0)
  }

  protected buildFinalizedData(
    response: QuoteMeltResponse<"future">,
  ): { preimage: string } | undefined {
    return response.payment_preimage == null ? undefined : { preimage: response.payment_preimage }
  }

  protected toCanonicalQuote(
    mintUrl: string,
    quote: FutureMeltQuoteResponse,
  ): BoltMeltQuote<"future"> {
    const now = Date.now()
    return {
      mintUrl,
      method: "future",
      quoteId: quote.quote,
      quote: quote.quote,
      request: quote.request,
      amount: Amount.from(quote.amount),
      unit: quote.unit,
      expiry: quote.expiry,
      state: quote.state,
      fee_reserve: Amount.from(quote.fee_reserve ?? 0),
      ...(quote.payment_preimage !== undefined
        ? { payment_preimage: quote.payment_preimage }
        : {}),
      createdAt: now,
      updatedAt: now,
    }
  }
}
