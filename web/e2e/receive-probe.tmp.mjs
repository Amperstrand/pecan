import { readFileSync } from "node:fs"
import { getDecodedToken } from "@cashu/cashu-ts"

const MINT = "https://giftcard.cashu.exchange/farm"
const token = readFileSync("/tmp/farm-token.txt", "utf8").trim()

try {
  const decoded = getDecodedToken(token)
  console.log("token unit:", decoded.unit, "proofs:", decoded.proofs.length)
  console.log("proof amounts:", decoded.proofs.map((p) => p.amount))
  console.log("secret[0]:", decoded.proofs[0]?.secret?.slice(0, 90))
} catch (e) {
  console.log("decode failed:", String(e).slice(0, 300))
  process.exit(1)
}

// Now a real receive through a cashu-ts wallet bound to the farm mint.
const { Wallet } = await import("@cashu/cashu-ts")
const w = await Wallet.create(MINT, { unit: "sat" })
console.log("wallet created")
try {
  const proofs = await w.receive(token)
  console.log("RECEIVED", proofs.length, "proofs", proofs.map((p) => p.amount))
} catch (e) {
  console.log("receive failed:", String(e).slice(0, 500))
  process.exit(1)
}
