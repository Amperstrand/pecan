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
import type { BranchMeltQuoteResponse } from "./branch-methods"

function proofsToSerializedChange(proofs: Proof[]): SerializedBlindedSignature[] | undefined {
  if (proofs.length === 0) return undefined
  return proofs.map((p) => ({ id: p.id, amount: p.amount, C_: p.C }))
}

export class MeltBranchHandler extends BaseQuoteMeltHandler<"branch"> {
  protected readonly method = "branch" as const

  /**
   * Swap on ANY overshoot — for two reasons. Change hygiene: the mint
   * (cdk-mintd ≥ 0.18.0) re-serves change signatures on quote checks, so
   * overshoot change IS recoverable, but the pre-swap keeps the common
   * case change-free. Fee control (the expensive lesson, 2026-09-03):
   * melting proof-granular selections pays per-proof input fees — a €6
   * melt from a 13-proof wallet cost €4.24 in fees. The pre-swap
   * consolidates inputs first; the fee reserve rides as change outputs
   * when a swap cannot be exact.
   */
  needsSwapFor(selectedAmount: Amount, totalAmount: Amount): boolean {
    return selectedAmount.greaterThan(totalAmount)
  }

  protected async createRemoteQuote(
    ctx: CreateMeltQuoteContext<"branch">,
  ): Promise<BranchMeltQuoteResponse> {
    // cdk-axum's custom melt handler requires `method` and `request` in the
    // body (MeltQuoteCustomRequest); `request` carries the recipient memo the
    // teller sees, mirroring the classic wallet's payload shape.
    // NUT #5: For a custom `{method}`, the wallet sends a request following the common melt quote request format (see [General Flow](#general-flow)). The `request` field is the method-specific payment target (e.g., a bank account identifier, an on-chain address, a payment processor reference). `unit` is the unit the wallet would like to pay with.
    return ctx.wallet.createMeltQuote<BranchMeltQuoteResponse>("branch", {
      method: "branch",
      request: ctx.methodData.description ?? "",
      unit: ctx.unit,
      amount: ctx.methodData.amount,
    })
  }

  protected async fetchRemoteMeltQuote(
    ctx: FetchRemoteMeltQuoteContext<"branch">,
  ): Promise<BranchMeltQuoteResponse> {
    return ctx.mintAdapter.checkMeltQuoteFor(ctx.quote.mintUrl, "branch", ctx.quote.quoteId)
  }

  protected async executeMelt(
    ctx: ExecuteContext<"branch">,
    proofsToMelt: Proof[],
    changeOutputs: Parameters<BaseQuoteMeltHandler<"branch">["executeMelt"]>[2],
    quoteId: string,
  ): Promise<QuoteMeltResponse<"branch">> {
    // Eager by design: the teller may only dispense cash once the wallet has
    // locked (burned) its proofs — the mint's make_payment marks the ticket
    // submitted, which mark-paid requires ("waiting for the wallet to lock
    // funds"). ASYNC per NUT-05: prefer_async makes the mint return
    // immediately after setup (inputs burned, PENDING). Change is deferred
    // with it and recovered from the quote check at finalize — see
    // needsSwapFor/checkMeltQuote.
    const preview = {
      method: "branch",
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
      // completeMelt's response quote is typed narrowly, but the mint's
      // full melt response (state, preimage) is merged into it at runtime.
      const q = res.quote as { state?: string; payment_preimage?: string | null }
      const state =
        q.state === "PAID" || q.state === "PENDING" ? q.state : "UNPAID"
      return {
        state,
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
    ctx: FinalizeContext<"branch"> | RecoverExecutingContext<"branch">,
  ): Promise<QuoteMeltResponse<"branch">> {
    // The mint stores a melt's change signatures with the quote and re-serves
    // them on state checks — this is the only way to recover the overpay when
    // the original melt response was lost (e.g. page reload during execute).
    const q = await ctx.mintAdapter.checkMeltQuoteFor(
      ctx.operation.mintUrl,
      "branch",
      ctx.operation.quoteId,
    )
    return {
      state: q.state,
      change: q.change as SerializedBlindedSignature[] | undefined,
      payment_preimage: q.payment_preimage,
    }
  }

  protected async checkMeltQuoteState(
    ctx: PendingContext<"branch"> | RecoverExecutingContext<"branch">,
  ): Promise<BoltMeltQuoteState> {
    const q = await ctx.mintAdapter.checkMeltQuoteFor(
      ctx.operation.mintUrl,
      "branch",
      ctx.operation.quoteId,
    )
    return q.state
  }

  protected getFeeReserveForQuote(
    quote: BranchMeltQuoteResponse,
    _operation: BasePrepareContext<"branch">["operation"],
  ): Amount {
    return Amount.from(quote.fee_reserve ?? 0)
  }

  protected buildFinalizedData(
    response: QuoteMeltResponse<"branch">,
  ): { preimage: string } | undefined {
    return response.payment_preimage == null ? undefined : { preimage: response.payment_preimage }
  }

  protected toCanonicalQuote(
    mintUrl: string,
    quote: BranchMeltQuoteResponse,
  ): BoltMeltQuote<"branch"> {
    const now = Date.now()
    return {
      mintUrl,
      method: "branch",
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
