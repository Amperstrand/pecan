import { describe, expect, it, vi } from "vitest"
import { Amount, MintOperationError } from "@cashu/cashu-ts"
import type {
  CreateMeltQuoteContext,
  ExecuteContext,
  FinalizeContext,
} from "@cashu/coco-core/operations/melt"
import { MeltBranchHandler } from "./melt-branch-handler"
import type { BranchMeltQuoteResponse } from "./branch-methods"

class TestableMeltHandler extends MeltBranchHandler {
  async callCreateRemoteQuote(ctx: CreateMeltQuoteContext<"branch">) {
    return this.createRemoteQuote(ctx)
  }

  async callExecuteMelt(
    ctx: ExecuteContext<"branch">,
    proofs: Parameters<MeltBranchHandler["executeMelt"]>[1],
    changeOutputs: Parameters<MeltBranchHandler["executeMelt"]>[2],
    quoteId: string,
  ) {
    return this.executeMelt(ctx, proofs, changeOutputs, quoteId)
  }

  async callCheckMeltQuote(ctx: FinalizeContext<"branch">) {
    return this.checkMeltQuote(ctx)
  }

  callGetFeeReserveForQuote(quote: BranchMeltQuoteResponse) {
    return this.getFeeReserveForQuote(quote, {
      id: "op",
      mintUrl: "https://mint.example",
      method: "branch",
      unit: "nok",
      methodData: {} as never,
      createdAt: 0,
      updatedAt: 0,
      state: "init",
    })
  }

  callBuildFinalizedData(response: { state: string; payment_preimage?: string | null }) {
    return this.buildFinalizedData(response as never)
  }
}

describe("MeltBranchHandler.createRemoteQuote", () => {
  it("sends method, request, unit and amount in the custom melt body (cdk-axum rejects bodies without method+request)", async () => {
    const createMeltQuote = vi.fn(
      async (_method: string, _payload: unknown) => ({}) as BranchMeltQuoteResponse,
    )
    const handler = new TestableMeltHandler()

    await handler.callCreateRemoteQuote({
      unit: "nok",
      methodData: { amount: Amount.from(500), description: "bob at the counter" },
      wallet: { createMeltQuote },
    } as unknown as CreateMeltQuoteContext<"branch">)

    expect(createMeltQuote).toHaveBeenCalledWith("branch", {
      method: "branch",
      request: "bob at the counter",
      unit: "nok",
      amount: Amount.from(500),
    })
  })

  it("defaults request to an empty string when no recipient memo is given", async () => {
    const createMeltQuote = vi.fn(
      async (_method: string, _payload: unknown) => ({}) as BranchMeltQuoteResponse,
    )
    const handler = new TestableMeltHandler()

    await handler.callCreateRemoteQuote({
      unit: "nok",
      methodData: { amount: Amount.from(500) },
      wallet: { createMeltQuote },
    } as unknown as CreateMeltQuoteContext<"branch">)

    expect(createMeltQuote.mock.calls[0][1]).toMatchObject({ request: "" })
  })
})

describe("MeltBranchHandler.executeMelt", () => {
  it("maps mint error 20005 (payment pending) to a PENDING quote state", async () => {
    const ctx = {
      wallet: {
        meltProofs: vi.fn(async () => {
          throw new MintOperationError(20005, "transaction pending")
        }),
      },
      operation: {
        id: "op1",
        mintUrl: "https://mint.example",
        amount: Amount.from(500),
        unit: "nok",
      },
    } as unknown as ExecuteContext<"branch">

    const result = await new TestableMeltHandler().callExecuteMelt(ctx, [], [], "q1")
    expect(result).toEqual({ state: "PENDING" })
  })

  it("rethrows non-pending mint errors", async () => {
    const ctx = {
      wallet: {
        meltProofs: vi.fn(async () => {
          throw new MintOperationError(20003, "insufficient funds")
        }),
      },
      operation: {
        id: "op1",
        mintUrl: "https://mint.example",
        amount: Amount.from(500),
        unit: "nok",
      },
    } as unknown as ExecuteContext<"branch">

    await expect(
      new TestableMeltHandler().callExecuteMelt(ctx, [], [], "q1"),
    ).rejects.toMatchObject({ code: 20003 })
  })
})

describe("MeltBranchHandler.checkMeltQuote (change recovery from state checks)", () => {
  const finalizeCtx = (remoteQuote: Record<string, unknown>) =>
    ({
      mintAdapter: {
        checkMeltQuoteFor: vi.fn(async () => remoteQuote),
      },
      operation: {
        id: "op1",
        mintUrl: "https://mint.example",
        quoteId: "q1",
        amount: Amount.from(500),
        unit: "nok",
      },
    }) as unknown as FinalizeContext<"branch">

  it("passes the mint's stored change signatures through so finalize can claim them", async () => {
    // The mint persists a melt's change with the quote and re-serves it on
    // state checks; dropping it here lost the overpay whenever the original
    // melt response died with a page reload.
    const change = [{ id: "ks1", amount: Amount.from(12), C_: "C_change" }]
    const result = await new TestableMeltHandler().callCheckMeltQuote(
      finalizeCtx({ state: "PAID", payment_preimage: "pre", change }),
    )
    expect(result).toEqual({ state: "PAID", change, payment_preimage: "pre" })
  })

  it("returns quotes without change unchanged", async () => {
    const result = await new TestableMeltHandler().callCheckMeltQuote(
      finalizeCtx({ state: "PENDING", payment_preimage: null }),
    )
    expect(result).toEqual({ state: "PENDING", change: undefined, payment_preimage: null })
  })
})

describe("MeltBranchHandler fee and finalization", () => {
  it("treats a missing fee_reserve as zero", () => {
    const fee = new TestableMeltHandler().callGetFeeReserveForQuote({
      quote: "q1",
    } as BranchMeltQuoteResponse)
    expect(Number(fee.toBigInt())).toBe(0)
  })

  it("reports the preimage as finalized data when the mint returns one", () => {
    const handler = new TestableMeltHandler()
    expect(
      handler.callBuildFinalizedData({ state: "PAID", payment_preimage: "deadbeef" }),
    ).toEqual({ preimage: "deadbeef" })
    expect(handler.callBuildFinalizedData({ state: "PAID" })).toBeUndefined()
  })
})
