import { Amount } from "@cashu/cashu-ts"
import { bytesToHex } from "@noble/curves/utils.js"
import {
  deriveBolt11MintQuoteState,
  deserializeOutputData,
  mapProofToCoreProof,
  serializeOutputData,
  type Keypair,
  type MintMethodHandler,
  type MintQuote,
  type PendingMintOperation,
} from "@cashu/coco-core"
import type {
  CreateMintQuoteContext,
  ExecuteContext,
  FetchRemoteMintQuoteContext,
  MintExecutionResult,
  PendingContext,
  PendingMintObservationResult,
  PrepareContext,
  RecoverExecutingContext,
  RecoverExecutingResult,
} from "@cashu/coco-core/operations/mint"
import type { BranchMintQuoteResponse } from "./branch-methods"

interface BranchKeyRing {
  generateMintQuoteKeyPair(): Promise<Keypair>
  getMintQuoteKeyPair(publicKeyHex: string): Promise<Keypair | null>
}

export class MintBranchHandler implements MintMethodHandler<"branch"> {
  constructor(private readonly keyRing: BranchKeyRing) {}

  async createQuote(ctx: CreateMintQuoteContext<"branch">): Promise<MintQuote<"branch">> {
    const { amount, description, locked } = ctx.createQuoteData
    const keypair = locked === true ? await this.keyRing.generateMintQuoteKeyPair() : null
    const lockPubkey = keypair !== null ? keypair.publicKeyHex : undefined

    const remote = await ctx.wallet.createMintQuote<BranchMintQuoteResponse>("branch", {
      amount: amount.amount,
      unit: amount.unit,
      ...(description !== undefined ? { description } : {}),
      ...(lockPubkey !== undefined ? { pubkey: lockPubkey } : {}),
    })
    if (lockPubkey !== undefined && remote.pubkey !== lockPubkey) {
      throw new Error("Mint returned a branch quote without the requested NUT-20 lock")
    }
    return this.toCanonical(ctx.mintUrl, remote, amount.unit)
  }

  async fetchRemoteQuote(
    ctx: FetchRemoteMintQuoteContext<"branch">,
  ): Promise<MintQuote<"branch">> {
    const remote = await ctx.mintAdapter.checkMintQuote(
      ctx.quote.mintUrl,
      "branch",
      ctx.quote.quoteId,
    )
    return this.toCanonical(ctx.quote.mintUrl, remote, ctx.quote.unit)
  }

  async prepare(
    ctx: PrepareContext<"branch">,
  ): Promise<PendingMintOperation<"branch"> & { method: "branch"; methodData: Record<string, never> }> {
    const quote = ctx.importedQuote
    if (!quote) {
      throw new Error(`Mint quote ${ctx.operation.quoteId ?? "(missing)"} was not provided`)
    }
    if (ctx.operation.quoteId !== quote.quote) {
      throw new Error(
        `Mint quote ${quote.quote} does not match operation quote ${ctx.operation.quoteId}`,
      )
    }

    const quoteUnit = quote.unit || ctx.operation.unit
    const outputData = await ctx.proofService.createOutputsAndIncrementCounters(
      ctx.operation.mintUrl,
      {
        keep: { amount: Amount.from(quote.amount ?? 0), unit: quoteUnit },
        send: { amount: Amount.zero(), unit: quoteUnit },
      },
      {},
    )
    if (outputData.keep.length === 0) {
      throw new Error("Failed to create deterministic outputs for mint operation")
    }

    return {
      ...ctx.operation,
      quoteId: quote.quote,
      request: quote.request,
      expiry: quote.expiry ?? null,
      ...(quote.pubkey !== undefined ? { pubkey: quote.pubkey } : {}),
      outputData: serializeOutputData({ keep: outputData.keep, send: [] }),
      state: "pending",
    }
  }

  async execute(ctx: ExecuteContext<"branch">): Promise<MintExecutionResult> {
    const outputData = deserializeOutputData(ctx.operation.outputData)
    const signingOptions = await this.getSigningOptions(ctx.operation.pubkey)
    try {
      const proofs = await ctx.wallet.mintProofs(
        "branch",
        ctx.operation.amount,
        { quote: ctx.operation.quoteId },
        signingOptions,
        { type: "custom", data: outputData.keep },
      )
      return { status: "ISSUED", proofs }
    } catch (err) {
      if (err instanceof Error && /20002|already/i.test(err.message)) {
        return { status: "ALREADY_ISSUED" }
      }
      throw err
    }
  }

  async recoverExecuting(ctx: RecoverExecutingContext<"branch">): Promise<RecoverExecutingResult> {
    const { mintUrl, quoteId } = ctx.operation
    let remote: BranchMintQuoteResponse
    try {
      remote = await ctx.mintAdapter.checkMintQuote(mintUrl, "branch", quoteId)
    } catch (error) {
      return {
        status: "PENDING",
        error: error instanceof Error ? error.message : String(error),
      }
    }

    if (remote.amount_issued.greaterThan(Amount.zero())) {
      try {
        const recovered = await ctx.proofService.recoverProofsFromOutputData(
          mintUrl,
          ctx.operation.outputData,
          {
            unit: ctx.operation.unit,
            createdByOperationId: ctx.operation.id,
          },
        )
        if (recovered.length > 0) {
          return { status: "FINALIZED" }
        }
      } catch {
        // proof recovery failed; stay pending for the next sweep
      }
      return { status: "PENDING", error: `Quote ${quoteId} issued remotely; proofs not yet recovered` }
    }

    if (remote.amount_paid.greaterThan(Amount.zero())) {
      const signingOptions = await this.getSigningOptions(ctx.operation.pubkey)
      const outputData = deserializeOutputData(ctx.operation.outputData)
      try {
        const proofs = await ctx.wallet.mintProofs(
          "branch",
          ctx.operation.amount,
          { quote: quoteId },
          signingOptions,
          { type: "custom", data: outputData.keep },
        )
        await ctx.proofService.saveProofs(
          mintUrl,
          mapProofToCoreProof(mintUrl, "ready", proofs, {
            unit: ctx.operation.unit,
            createdByOperationId: ctx.operation.id,
          }),
        )
        return { status: "FINALIZED" }
      } catch (err) {
        if (err instanceof Error && /20002|already/i.test(err.message)) {
          return { status: "PENDING", error: "Quote already issued; awaiting proof recovery" }
        }
        return { status: "PENDING", error: err instanceof Error ? err.message : String(err) }
      }
    }

    return { status: "PENDING", error: `Quote ${quoteId} not yet paid` }
  }

  async checkPending(
    ctx: PendingContext<"branch">,
  ): Promise<PendingMintObservationResult<"branch">> {
    const remote = await ctx.mintAdapter.checkMintQuote(
      ctx.operation.mintUrl,
      "branch",
      ctx.operation.quoteId,
    )
    return {
      observedAt: Date.now(),
      quoteSnapshot: remote,
    }
  }

  private async getSigningOptions(
    pubkey: string | undefined,
  ): Promise<{ privkey: string } | undefined> {
    if (pubkey === undefined) return undefined
    const key = await this.keyRing.getMintQuoteKeyPair(pubkey)
    if (!key) {
      throw new Error(`Missing NUT-20 lock key for branch quote (${pubkey})`)
    }
    return { privkey: bytesToHex(key.secretKey) }
  }

  private toCanonical(
    mintUrl: string,
    remote: BranchMintQuoteResponse,
    unit: string,
  ): MintQuote<"branch"> {
    const now = Date.now()
    const amountPaid = Amount.from(remote.amount_paid)
    const amountIssued = Amount.from(remote.amount_issued)
    return {
      mintUrl,
      method: "branch",
      quoteId: remote.quote,
      quote: remote.quote,
      request: remote.request,
      unit: remote.unit || unit,
      expiry: remote.expiry,
      ...(remote.pubkey !== undefined ? { pubkey: remote.pubkey } : {}),
      reusable: false,
      amount: Amount.from(remote.amount ?? 0),
      amountPaid,
      amountIssued,
      state: deriveBolt11MintQuoteState(amountPaid, amountIssued),
      remoteUpdatedAt: remote.updated_at,
      quoteData: { request: remote.request },
      createdAt: now,
      updatedAt: now,
    }
  }
}
