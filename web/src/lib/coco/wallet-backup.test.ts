import { describe, expect, it } from "vitest"

import {
  parseWalletDump,
  reviveRow,
  serializeRow,
} from "./wallet-backup"

/** JSON round-trip so overrides can carry deliberately-invalid shapes. */
function rawDump(overrides: Record<string, unknown> = {}): unknown {
  return JSON.parse(
    JSON.stringify({
      exportedAt: "2026-09-01T00:00:00.000Z",
      unit: "eur",
      seed: "ab".repeat(64),
      mintUrl: "https://giftcard.cashu.exchange/eur",
      proofs: [{ mintUrl: "https://x/eur", secret: "s1", amount: 500 }],
      mintOperations: [],
      meltOperations: [],
      history: [{ id: 1, type: "deposit", amount: 500 }],
      ...overrides,
    }),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  throw new Error("expected a record")
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  throw new Error("expected bytes")
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value
  throw new Error("expected a date")
}

describe("parseWalletDump", () => {
  it("accepts a well-formed dump", () => {
    const dump = parseWalletDump(rawDump())
    expect(dump.seed).toBe("ab".repeat(64))
    expect(dump.proofs).toHaveLength(1)
  })

  it("rejects non-objects", () => {
    for (const raw of ["nope", 42, null, ["array"]]) {
      expect(() => parseWalletDump(raw)).toThrow(/not a wallet backup/)
    }
  })

  it("rejects a missing or malformed seed", () => {
    expect(() => parseWalletDump(rawDump({ seed: null }))).toThrow(/seed/)
    expect(() => parseWalletDump(rawDump({ seed: "abcd" }))).toThrow(/seed/)
    expect(() => parseWalletDump(rawDump({ seed: "zz".repeat(64) }))).toThrow(/seed/)
  })

  it("rejects dumps whose row lists are not arrays of records", () => {
    expect(() => parseWalletDump(rawDump({ proofs: "nope" }))).toThrow(/proofs/)
    expect(() => parseWalletDump(rawDump({ history: [1, 2, 3] }))).toThrow(/history/)
    expect(() =>
      parseWalletDump(rawDump({ mintOperations: [null] })),
    ).toThrow(/mintOperations/)
  })

  it("rejects dumps missing metadata fields", () => {
    expect(() => parseWalletDump(rawDump({ exportedAt: 123 }))).toThrow(/timestamp/)
    expect(() => parseWalletDump(rawDump({ unit: 5 }))).toThrow(/mint information/)
  })
})

describe("dump row serialization", () => {
  it("round-trips nested bytes, dates, and plain values through JSON", () => {
    const when = new Date("2026-09-01T12:00:00.000Z")
    const row = {
      mintUrl: "https://x/eur",
      secret: "hexstring",
      amount: 500,
      bytes: new Uint8Array([0, 127, 255, 1]),
      nested: {
        deeper: [new Uint8Array([9]), "keep", null],
        when,
      },
      plainList: [1, 2, 3],
    }
    const revived = reviveRow(JSON.parse(JSON.stringify(serializeRow(row))))
    expect(Array.from(asBytes(revived.bytes))).toEqual([0, 127, 255, 1])
    const nested = asRecord(revived.nested)
    const deeper = nested.deeper
    if (!Array.isArray(deeper)) throw new Error("expected an array")
    expect(Array.from(asBytes(deeper[0]))).toEqual([9])
    expect(deeper[1]).toBe("keep")
    expect(asDate(nested.when).toISOString()).toBe(when.toISOString())
    expect(revived.plainList).toEqual([1, 2, 3])
    expect(revived.secret).toBe("hexstring")
  })

  it("does not revive an ordinary number list as bytes", () => {
    const revived = reviveRow(serializeRow({ list: [300, 999] }))
    expect(revived.list).toEqual([300, 999])
  })
})
