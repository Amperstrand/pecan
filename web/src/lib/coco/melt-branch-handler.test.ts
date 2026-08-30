import { describe, expect, it, vi } from "vitest"
import { Amount, MintOperationError } from "@cashu/cashu-ts"
import type {
  CreateMeltQuoteContext,
  ExecuteContext,
  FinalizeContext,
} from "@cashu/coco-core/operations/melt"
import { serializeOutputData } from "@cashu/coco-core"
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
        needsSwap: true,
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
        needsSwap: true,
      },
    } as unknown as ExecuteContext<"branch">

    await expect(
      new TestableMeltHandler().callExecuteMelt(ctx, [], [], "q1"),
    ).rejects.toMatchObject({ code: 20003 })
  })

  it("defers direct melts while the teller quote is unpaid (nothing is burned)", async () => {
    const meltProofs = vi.fn()
    const ctx = {
      wallet: { meltProofs },
      mintAdapter: {
        checkMeltQuoteFor: vi.fn(async () => ({ state: "UNPAID" })),
      },
      operation: {
        id: "op1",
        mintUrl: "https://mint.example",
        amount: Amount.from(500),
        unit: "nok",
        needsSwap: false,
      },
    } as unknown as ExecuteContext<"branch">

    const result = await new TestableMeltHandler().callExecuteMelt(ctx, [], [], "q1")
    expect(result).toEqual({ state: "PENDING" })
    expect(meltProofs).not.toHaveBeenCalled()
  })

  it("melts directly when the quote is already paid", async () => {
    const meltProofs = vi.fn(async () => ({
      quote: { state: "PAID", payment_preimage: "pre" },
      change: [],
    }))
    const ctx = {
      wallet: { meltProofs },
      mintAdapter: {
        checkMeltQuoteFor: vi.fn(async () => ({ state: "PAID" })),
      },
      operation: {
        id: "op1",
        mintUrl: "https://mint.example",
        amount: Amount.from(500),
        unit: "nok",
        needsSwap: false,
      },
    } as unknown as ExecuteContext<"branch">

    const result = await new TestableMeltHandler().callExecuteMelt(ctx, [], [], "q1")
    expect(result.state).toBe("PAID")
    expect(meltProofs).toHaveBeenCalledTimes(1)
  })
})

describe("MeltBranchHandler.checkMeltQuote (deferred melt at settlement)", () => {
  const changeOutputData = serializeOutputData({ keep: [], send: [] })

  const finalizeCtx = (overrides: {
    quoteState?: string
    meltProofs?: ReturnType<typeof vi.fn>
    getProofs?: ReturnType<typeof vi.fn>
  }) => {
    const meltProofs =
      overrides.meltProofs ??
      vi.fn(async () => ({ quote: { state: "PAID", payment_preimage: "pre" }, change: [] }))
    return {
      walletService: {
        getWalletWithActiveKeysetId: vi.fn(async () => ({ wallet: { meltProofs } })),
      },
      mintAdapter: {
        checkMeltQuoteFor: vi.fn(async () => ({
          state: overrides.quoteState ?? "PAID",
          payment_preimage: "pre",
        })),
      },
      proofRepository: {
        getProofsByOperationId:
          overrides.getProofs ?? vi.fn(async () => [{ secret: "s1", amount: Amount.from(512) }]),
      },
      operation: {
        id: "op1",
        mintUrl: "https://mint.example",
        quoteId: "q1",
        amount: Amount.from(500),
        unit: "nok",
        needsSwap: false,
        changeOutputData,
      },
    } as unknown as FinalizeContext<"branch">
  }

  it("performs the deferred melt once the quote is paid", async () => {
    const meltProofs = vi.fn(async () => ({
      quote: { state: "PAID", payment_preimage: "pre" },
      change: [],
    }))
    const result = await new TestableMeltHandler().callCheckMeltQuote(
      finalizeCtx({ meltProofs }),
    )
    expect(result.state).toBe("PAID")
    expect(meltProofs).toHaveBeenCalledTimes(1)
  })

  it("treats already-spent inputs as settled when an earlier response was lost", async () => {
    const meltProofs = vi.fn(async () => {
      throw new MintOperationError(20006, "inputs have already been spent")
    })
    const result = await new TestableMeltHandler().callCheckMeltQuote(
      finalizeCtx({ meltProofs }),
    )
    expect(result).toEqual({ state: "PAID", payment_preimage: "pre" })
  })

  it("passes non-paid quote states through without melting", async () => {
    const meltProofs = vi.fn()
    const result = await new TestableMeltHandler().callCheckMeltQuote(
      finalizeCtx({ quoteState: "PENDING", meltProofs }),
    )
    expect(result.state).toBe("PENDING")
    expect(meltProofs).not.toHaveBeenCalled()
  })

  it("rethrows unexpected melt failures for the retry loop", async () => {
    const meltProofs = vi.fn(async () => {
      throw new MintOperationError(20003, "insufficient funds")
    })
    await expect(
      new TestableMeltHandler().callCheckMeltQuote(finalizeCtx({ meltProofs })),
    ).rejects.toMatchObject({ code: 20003 })
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
