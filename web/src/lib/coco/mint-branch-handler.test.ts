import { describe, expect, it, vi } from "vitest"
import { Amount } from "@cashu/cashu-ts"
import type { Keypair, MintQuote } from "@cashu/coco-core"
import type { CreateMintQuoteContext } from "@cashu/coco-core/operations/mint"
import { MintBranchHandler } from "./mint-branch-handler"
import type { BranchMintQuoteResponse } from "./branch-methods"

const LOCK_PUBKEY = "02a0a67f73ad84ec00059b8262077a19528c77b38d7bb857bd981b03d791bf2c9"

const LOCK_KEYPAIR: Keypair = {
  publicKeyHex: LOCK_PUBKEY,
  secretKey: new Uint8Array(32).fill(7),
} as unknown as Keypair

function remoteResponse(over: Partial<BranchMintQuoteResponse> = {}): BranchMintQuoteResponse {
  return {
    quote: "01a04c2f-78bc-7d41-873b-cb37e7319099",
    request: "MINT-01a04c2f-78bc-7d41-873b-cb37e7319099",
    amount: 500,
    unit: "nok",
    expiry: 1787986374,
    pubkey: LOCK_PUBKEY,
    state: "UNPAID",
    amount_paid: 0,
    amount_issued: 0,
    updated_at: 1787984574,
    ...over,
  } as BranchMintQuoteResponse
}

function mintCtx<M extends "branch" | "ln">(
  createMintQuote: CreateMintQuoteContext<M>["wallet"]["createMintQuote"],
  createQuoteData: CreateMintQuoteContext<M>["createQuoteData"],
): CreateMintQuoteContext<M> {
  return {
    mintUrl: "https://mint.example",
    createQuoteData,
    wallet: { createMintQuote },
  } as unknown as CreateMintQuoteContext<M>
}

function lockedKeyRing() {
  return {
    generateMintQuoteKeyPair: vi.fn(async () => LOCK_KEYPAIR),
    getMintQuoteKeyPair: vi.fn(async () => LOCK_KEYPAIR),
  }
}

describe("MintBranchHandler.createQuote", () => {
  it("locks the quote with a fresh NUT-20 pubkey and sends the common NUT-04 fields", async () => {
    const createMintQuote = vi.fn(
      async (_method: string, _payload: Record<string, unknown>): Promise<never> =>
        remoteResponse() as never,
    )
    const keyRing = lockedKeyRing()

    const quote = await new MintBranchHandler("branch", keyRing).createQuote(
      mintCtx(createMintQuote, {
        amount: { amount: Amount.from(500), unit: "nok" },
        description: "Wallet deposit",
        locked: true,
      }),
    )

    expect(keyRing.generateMintQuoteKeyPair).toHaveBeenCalledOnce()
    expect(createMintQuote).toHaveBeenCalledWith("branch", {
      amount: Amount.from(500),
      unit: "nok",
      description: "Wallet deposit",
      pubkey: LOCK_PUBKEY,
    })
    expect(quote.pubkey).toBe(LOCK_PUBKEY)
  })

  it("omits the pubkey for unlocked quotes", async () => {
    const createMintQuote = vi.fn(
      async (_method: string, _payload: Record<string, unknown>): Promise<never> =>
        remoteResponse({ pubkey: undefined }) as never,
    )
    await new MintBranchHandler("branch", lockedKeyRing()).createQuote(
      mintCtx(createMintQuote, {
        amount: { amount: Amount.from(500), unit: "nok" },
      }),
    )

    expect(createMintQuote.mock.calls[0][1]).not.toHaveProperty("pubkey")
  })

  it("tags ln quotes with the rail marker the processor routes on", async () => {
    const createMintQuote = vi.fn(
      async (_method: string, _payload: Record<string, unknown>): Promise<never> =>
        remoteResponse() as never,
    )
    await new MintBranchHandler("ln", lockedKeyRing()).createQuote(
      mintCtx(createMintQuote, {
        amount: { amount: Amount.from(500), unit: "nok" },
        locked: true,
      }),
    )

    expect(createMintQuote).toHaveBeenCalledWith("ln", {
      amount: Amount.from(500),
      unit: "nok",
      pubkey: LOCK_PUBKEY,
      rail: "ln",
    })
  })

  it("rejects a mint response that dropped the requested NUT-20 lock", async () => {
    const createMintQuote = vi.fn(
      async (_method: string, _payload: Record<string, unknown>): Promise<never> =>
        remoteResponse({ pubkey: undefined }) as never,
    )
    await expect(
      new MintBranchHandler("branch", lockedKeyRing()).createQuote(
        mintCtx(createMintQuote, {
          amount: { amount: Amount.from(500), unit: "nok" },
          locked: true,
        }),
      ),
    ).rejects.toThrow("NUT-20 lock")
  })

  it("carries the amount into quoteData so IndexedDB quote serialization roundtrips", async () => {
    const createMintQuote = vi.fn(
      async (_method: string, _payload: Record<string, unknown>): Promise<never> =>
        remoteResponse() as never,
    )
    const quote: MintQuote<"branch"> = await new MintBranchHandler("branch", lockedKeyRing()).createQuote(
      mintCtx(createMintQuote, {
        amount: { amount: Amount.from(500), unit: "nok" },
        locked: true,
      }),
    )

    const stateful = quote as MintQuote<"branch"> & {
      quoteData: { amount: Amount }
      amountPaid: Amount
      amountIssued: Amount
    }
    expect(Number(stateful.quoteData.amount.toBigInt())).toBe(500)
    expect(Number(stateful.amountPaid.toBigInt())).toBe(0)
    expect(Number(stateful.amountIssued.toBigInt())).toBe(0)
    expect(stateful.quoteData.request).toContain("MINT-")
    expect(stateful.state).toBe("UNPAID")
  })
})
