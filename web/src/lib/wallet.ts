import { Wallet } from "@cashu/cashu-ts"
import Dexie, { type EntityTable } from "dexie"


interface StoredProof {
  id: string
  amount: number
  secret: string
  C: string
  keyset_id: string
  reserved: boolean
  created_at: number
  raw?: string
    }

interface StoredSeed {
  id: string
  value: string
}

interface HistoryEntry {
  id?: number
  type: "deposit" | "withdraw"
  amount_ore: number
  description: string
  created_at: number
}

interface PendingQuote {
  id: string
  quote_id: string
  amount: number
  privkey: string
  created_at: number
}

const db = new Dexie("giftcard-wallet") as Dexie & {
  proofs: EntityTable<StoredProof, "id">
  seeds: EntityTable<StoredSeed, "id">
  history: EntityTable<HistoryEntry, "id">
  pending: EntityTable<PendingQuote, "id">
}

db.version(1).stores({
  proofs: "id, amount, reserved, keyset_id",
  seeds: "id",
  history: "++id, type, created_at",
  pending: "id, quote_id, created_at",
})

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function fromHex(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return arr
}

function randomBytes(length: number): Uint8Array {
  const arr = new Uint8Array(length)
  crypto.getRandomValues(arr)
  return arr
}

function loadSeed(): Uint8Array {
  return randomBytes(64)
}

async function getStoredSeed(): Promise<Uint8Array> {
  const existing = await db.seeds.get("main")
  if (existing) {
    return fromHex(existing.value)
  }
  const seed = loadSeed()
  await db.seeds.put({ id: "main", value: toHex(seed) })
  return seed
}

export async function getWallet(): Promise<Wallet> {
  const seed = await getStoredSeed()
  const wallet = new Wallet(window.location.origin, {
    unit: "nok",
    bip39seed: seed,
  })
  await wallet.loadMint()
  return wallet
}

export async function getBalanceOre(): Promise<number> {
  const all = await db.proofs.toArray()
  return all.filter((p) => !p.reserved).reduce((sum, p) => sum + Number(p.amount), 0)
}

export async function getUnspentProofs(): Promise<StoredProof[]> {
  const all = await db.proofs.toArray()
  return all.filter((p) => !p.reserved)
}

export async function addProofs(proofs: unknown[]): Promise<number> {
  const now = Date.now()
  const records = proofs.map((p, i) => {
    const proof = p as Record<string, unknown>
    const amountNum = Number(String(proof.amount ?? 0)) || 0
    return {
      id: `${now}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      amount: amountNum,
      secret: String(proof.secret ?? ""),
      C: String(proof.C ?? ""),
      keyset_id: String(proof.id ?? ""),
      reserved: false,
      created_at: now,
      raw: JSON.stringify(proof),
    }
  })
  await db.proofs.bulkAdd(records)
  return records.length
}

export async function markReserved(ids: string[]): Promise<void> {
  for (const id of ids) {
    const proof = await db.proofs.get(id)
    if (proof) {
      await db.proofs.put({ ...proof, reserved: true })
    }
  }
}

export async function removeProofs(ids: string[]): Promise<void> {
  await db.proofs.bulkDelete(ids)
}

export async function addHistory(
  type: "deposit" | "withdraw",
  amountOre: number,
  description: string,
): Promise<void> {
  await db.history.add({
    type,
    amount_ore: amountOre,
    description,
    created_at: Date.now(),
  })
}

export async function getHistory(limit = 20): Promise<HistoryEntry[]> {
  return db.history.orderBy("created_at").reverse().limit(limit).toArray()
}

export async function generateKeypair(): Promise<{
  pubkeyHex: string
  privHex: string
}> {
  const priv = randomBytes(32)
  const { secp256k1 } = await import("@noble/curves/secp256k1.js")
  const pub = secp256k1.getPublicKey(new Uint8Array(priv), true)
  return {
    pubkeyHex: toHex(pub),
    privHex: toHex(priv),
  }
}

export interface DepositQuote {
  quoteId: string
  tail: string
  amountOre: number
  privkey: string
}

export async function createDepositQuote(amountKr: number): Promise<DepositQuote> {
  const wallet = await getWallet()
  const { pubkeyHex, privHex } = await generateKeypair()
  const amountOre = Math.round(amountKr * 100)

  const quote = await wallet.createMintQuote("branch", {
    amount: amountOre,
    description: "Wallet deposit",
    pubkey: pubkeyHex,
  })

  return {
    quoteId: quote.quote,
    tail: quote.quote.slice(-6).toUpperCase(),
    amountOre,
    privkey: privHex,
  }
}

export async function pollAndMint(
  quoteId: string,
  amountOre: number,
  privkey: string,
): Promise<boolean> {
  const wallet = await getWallet()
  const status = await wallet.checkMintQuote("branch", quoteId)
  const paid = Number(String(status.amount_paid ?? 0)) || 0
  if (paid === 0) return false

  const quoteObj = await wallet.checkMintQuote("branch", quoteId)
  const proofs = await wallet.mintProofs("branch", amountOre, quoteObj, {
    privkey,
  })
  await addProofs(proofs)
  await addHistory("deposit", amountOre, `Deposit · ${proofs.length} proofs`)
  return true
}

export interface WithdrawResult {
  quoteId: string
  tail: string
  amountOre: number
  submitted: boolean
}

function findExactSubset(proofs: StoredProof[], target: number): StoredProof[] | null {
  const n = proofs.length
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += proofs[i].amount
    if (sum === target) return proofs.filter((_, i) => mask & (1 << i))
  }
  return null
}

export async function createWithdraw(
  amountKr: number,
  recipient: string,
): Promise<WithdrawResult> {
  const wallet = await getWallet()
  const amountOre = Math.round(amountKr * 100)

  const quote = await wallet.createMeltQuote("branch", {
    method: "branch",
    request: recipient,
    unit: "nok",
    amount: amountOre,
  })

  const fee = 0 // pecan branch method has no fee; add dynamic fee when supported
  const need = amountOre + fee
  const unspent = await getUnspentProofs()

  // Try exact subset first (avoids needing change)
  const subset = findExactSubset(unspent, need)

  // Fall back to all proofs if they exactly cover the need
  const selected = subset || (unspent.reduce((s, p) => s + p.amount, 0) === need ? unspent : null)

  if (!selected) {
    throw new Error(
      `Need exactly ${need} øre for this withdraw. Current proofs don't have an exact subset. Try withdrawing your full balance.`,
    )
  }

  // Use raw JSON (preserves cashu-ts types) or reconstruct from stored fields
  const proofArgs = selected.map((p) => {
    if (p.raw) {
      try {
        return JSON.parse(p.raw)
      } catch {
        // fall through to reconstruction
      }
    }
    return { amount: p.amount, secret: p.secret, C: p.C, id: p.keyset_id }
  })

  let submitted = false
  try {
    await wallet.meltProofs("branch", quote, proofArgs)
    submitted = true
    // Mark submitted proofs as reserved
    for (const p of selected) {
      await db.proofs.put({ ...p, reserved: true })
    }
  } catch (e) {
    console.warn("meltProofs failed:", e)
    submitted = false
  }

  await addHistory("withdraw", amountOre, `Withdraw · ${recipient}`)
  return {
    quoteId: quote.quote,
    tail: quote.quote.slice(-6).toUpperCase(),
    amountOre,
    submitted,
  }
}

export async function pollWithdraw(quoteId: string): Promise<string | null> {
  const wallet = await getWallet()
  const status = await wallet.checkMeltQuote("branch", quoteId)
  const st = status as Record<string, unknown>
  if (st.state === "PAID") {
    return String(st.payment_preimage || st.payment_proof || "PAID")
  }
  return null
}

export async function isWalletInitialized(): Promise<boolean> {
  const seed = await db.seeds.get("main")
  return !!seed
}
