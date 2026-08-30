import { Amount, MintOperationError, type Proof, type SerializedBlindedSignature } from "@cashu/cashu-ts"
import {
  BaseQuoteMeltHandler,
  deserializeOutputData,
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

function inputsAlreadySpent(err: unknown): boolean {
  if (!(err instanceof MintOperationError)) return false
  return err.code === 20006 || /spent/i.test(String(err.message ?? ""))
}

export class MeltBranchHandler extends BaseQuoteMeltHandler<"branch"> {
  protected readonly method = "branch" as const

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
    // Swap-then-melt sends exact-amount proofs (this rail's fee_reserve is 0),
    // so an eager melt cannot lose anything meaningful to a lost response.
    if (ctx.operation.needsSwap) {
      return this.meltProofsFor(ctx.wallet, ctx.operation, proofsToMelt, changeOutputs, quoteId)
    }
    // Direct melts can overshoot (proof granularity) and the overpay is
    // returned as one-time change signatures in the melt response. Melting an
    // UNPAID teller quote burns the inputs immediately, stranding that change
    // in a response a page reload can kill. Defer the melt until the teller
    // settles; checkMeltQuote performs it once the quote is PAID.
    const state = await this.remoteQuoteState(ctx, quoteId)
    if (state !== "PAID") {
      return { state: "PENDING" }
    }
    return this.meltProofsFor(ctx.wallet, ctx.operation, proofsToMelt, changeOutputs, quoteId)
  }

  protected async checkMeltQuote(
    ctx: FinalizeContext<"branch"> | RecoverExecutingContext<"branch">,
  ): Promise<QuoteMeltResponse<"branch">> {
    const q = await ctx.mintAdapter.checkMeltQuoteFor(
      ctx.operation.mintUrl,
      "branch",
      ctx.operation.quoteId,
    )
    if (q.state !== "PAID" || ctx.operation.needsSwap) {
      return { state: q.state, payment_preimage: q.payment_preimage }
    }
    // The deferred direct melt happens here, with the change response
    // processed live by finalize. If an earlier attempt's response was lost,
    // the mint refuses the already-spent inputs — settle without change.
    const inputs = await ctx.proofRepository.getProofsByOperationId(
      ctx.operation.mintUrl,
      ctx.operation.id,
    )
    const changeOutputs = deserializeOutputData(ctx.operation.changeOutputData).keep
    const { wallet } = await ctx.walletService.getWalletWithActiveKeysetId(
      ctx.operation.mintUrl,
      ctx.operation.unit,
    )
    try {
      return await this.meltProofsFor(
        wallet,
        ctx.operation,
        inputs,
        changeOutputs,
        ctx.operation.quoteId,
      )
    } catch (err) {
      if (inputsAlreadySpent(err)) {
        return { state: "PAID", payment_preimage: q.payment_preimage }
      }
      throw err
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

  private async meltProofsFor(
    wallet: ExecuteContext<"branch">["wallet"],
    operation: Pick<ExecuteContext<"branch">["operation"], "amount" | "unit">,
    proofsToMelt: Proof[],
    changeOutputs: Parameters<BaseQuoteMeltHandler<"branch">["executeMelt"]>[2],
    quoteId: string,
  ): Promise<QuoteMeltResponse<"branch">> {
    try {
      const res = await wallet.meltProofs(
        "branch",
        {
          quote: quoteId,
          amount: operation.amount,
          request: "",
          unit: operation.unit,
        } as BranchMeltQuoteResponse,
        proofsToMelt,
        undefined,
        { type: "custom", data: changeOutputs },
      )
      return {
        state: res.quote.state,
        change: proofsToSerializedChange(res.change),
        payment_preimage: res.quote.payment_preimage,
      }
    } catch (err) {
      if (err instanceof MintOperationError && err.code === 20005) {
        return { state: "PENDING" }
      }
      throw err
    }
  }

  private async remoteQuoteState(
    ctx: ExecuteContext<"branch">,
    quoteId: string,
  ): Promise<BoltMeltQuoteState> {
    const q = await ctx.mintAdapter.checkMeltQuoteFor(ctx.operation.mintUrl, "branch", quoteId)
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
