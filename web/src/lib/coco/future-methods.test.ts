import { describe, expect, it } from "vitest"
import { schnorr } from "@noble/curves/secp256k1.js"
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js"
import { futureTagOfSecret, isFutureUnit } from "./future-methods"

const TERMS_URI =
  "https://giftcard.cashu.exchange/farm-console/terms/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

describe("futureTagOfSecret", () => {
  it("extracts the exactly-one future tag", () => {
    const secret = JSON.stringify({
      secret: "deadbeef",
      tags: [["future", "1", TERMS_URI]],
    })
    expect(futureTagOfSecret(secret)).toEqual({ version: "1", termsUri: TERMS_URI })
  })

  it("tolerates other tags but not zero or two future tags", () => {
    const mixed = JSON.stringify({
      secret: "x",
      tags: [["purpose", "test"], ["future", "1", TERMS_URI]],
    })
    expect(futureTagOfSecret(mixed)).toEqual({ version: "1", termsUri: TERMS_URI })
    expect(futureTagOfSecret(JSON.stringify({ secret: "x", tags: [["purpose", "y"]] }))).toBeNull()
    expect(
      futureTagOfSecret(
        JSON.stringify({
          secret: "x",
          tags: [
            ["future", "1", TERMS_URI],
            ["future", "1", TERMS_URI],
          ],
        }),
      ),
    ).toBeNull()
  })

  it("returns null for plain (untagged) secrets and junk", () => {
    expect(futureTagOfSecret("deadbeef")).toBeNull()
    expect(futureTagOfSecret("")).toBeNull()
    expect(futureTagOfSecret("{not json")).toBeNull()
  })
})

describe("isFutureUnit", () => {
  it("recognizes the NUT-32 grammar prefixes only", () => {
    expect(isFutureUnit("future:farm-egg:20260918T160000Z")).toBe(true)
    expect(isFutureUnit("eur")).toBe(false)
    expect(isFutureUnit("sat")).toBe(false)
    expect(isFutureUnit("future:farm")).toBe(true) // prefix check; server validates fully
  })
})

describe("terms signature verification (client-side pin)", () => {
  it("verifies a BIP-340 signature over the domain-prefixed canonical payload", async () => {
    const priv = hexToBytes(''.repeat(0) + 'a'.repeat(63) + 'b')
    const pubkey = schnorr.getPublicKey(priv)
    const terms = {
      contract_size: "1",
      production_capacity: "10",
      reference_price_sats: "1000",
      settlement_method: "physical",
      unit: "future:farm-egg:20260918T160000Z",
    }
    // Canonical: sorted keys, no whitespace — mirrors the cdk fork's
    // canonical_json and the processor's canonical_envelope.
    const sortedCanonical = canonicalJson({
      mint: "https://giftcard.cashu.exchange/farm",
      terms,
    })
    const msg = new TextEncoder().encode(`Cashu_NUT32_Terms_v1:${sortedCanonical}`)
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", msg))
    const signature = schnorr.sign(digest, priv)
    expect(schnorr.verify(signature, digest, pubkey)).toBe(true)

    // Any byte change flips verification.
    const tampered = new Uint8Array(digest)
    tampered[0] ^= 1
    expect(schnorr.verify(signature, tampered, pubkey)).toBe(false)
  })
})

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

describe("canonicalJson helper", () => {
  it("sorts keys at every depth and matches the Rust canonical form", () => {
    expect(canonicalJson({ b: "1", a: "2" })).toBe('{"a":"2","b":"1"}')
    expect(canonicalJson({ z: { b: "1", a: "2" }, y: [{ k: "v" }] })).toBe(
      '{"y":[{"k":"v"}],"z":{"a":"2","b":"1"}}',
    )
  })

  it("round-trips hex bytes", () => {
    const bytes = hexToBytes("00112233")
    expect(bytesToHex(bytes)).toBe("00112233")
  })
})
