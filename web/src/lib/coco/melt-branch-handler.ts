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

  protected async createRemoteQuote(
    ctx: CreateMeltQuoteContext<"branch">,
  ): Promise<BranchMeltQuoteResponse> {
    return ctx.wallet.createMeltQuote<BranchMeltQuoteResponse>("branch", {
      unit: ctx.unit,
      amount: ctx.methodData.amount,
      ...(ctx.methodData.description !== undefined
        ? { description: ctx.methodData.description }
        : {}),
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
    try {
      const res = await ctx.wallet.meltProofs(
        "branch",
        {
          quote: quoteId,
          amount: ctx.operation.amount,
          request: "",
          unit: ctx.operation.unit,
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

  protected async checkMeltQuote(
    ctx: FinalizeContext<"branch"> | RecoverExecutingContext<"branch">,
  ): Promise<QuoteMeltResponse<"branch">> {
    const q = await ctx.mintAdapter.checkMeltQuoteFor(
      ctx.operation.mintUrl,
      "branch",
      ctx.operation.quoteId,
    )
    return { state: q.state, payment_preimage: q.payment_preimage }
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
