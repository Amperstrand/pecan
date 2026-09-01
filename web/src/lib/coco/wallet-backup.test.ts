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
      formatVersion: 2,
      exportedAt: "2026-09-01T00:00:00.000Z",
      unit: "eur",
      seed: "ab".repeat(64),
      mintUrl: "https://giftcard.cashu.exchange/eur",
      stores: {
        coco_cashu_proofs: [{ mintUrl: "https://x/eur", secret: "s1", amount: 500 }],
        coco_cashu_mint_operations: [],
        coco_cashu_melt_operations: [],
        coco_cashu_history: [{ id: 1, type: "deposit", amount: 500 }],
      },
      ...overrides,
    }),
  )
}

/** A v1 dump: the four money stores as top-level fields, no version. */
function rawV1Dump(overrides: Record<string, unknown> = {}): unknown {
  return JSON.parse(
    JSON.stringify({
      exportedAt: "2026-09-01T00:00:00.000Z",
      unit: "eur",
      seed: "ab".repeat(64),
      mintUrl: "https://giftcard.cashu.exchange/eur",
      proofs: [{ mintUrl: "https://x/eur", secret: "s1", amount: 500 }],
      mintOperations: [],
      meltOperations: [],
      history: [],
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
  it("accepts a well-formed v2 dump", () => {
    const dump = parseWalletDump(rawDump())
    expect(dump.seed).toBe("ab".repeat(64))
    expect(dump.formatVersion).toBe(2)
    expect(dump.stores["coco_cashu_proofs"]).toHaveLength(1)
    expect(Object.keys(dump.stores)).toContain("coco_cashu_history")
  })

  it("accepts a v1 dump and maps its fields into the stores map", () => {
    const dump = parseWalletDump(rawV1Dump())
    expect(dump.formatVersion).toBe(2)
    expect(dump.stores["coco_cashu_proofs"]).toHaveLength(1)
    expect(dump.stores["coco_cashu_melt_operations"]).toEqual([])
    expect(dump.stores["coco_cashu_history"]).toEqual([])
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

  it("rejects v2 dumps whose stores hold non-records", () => {
    expect(() =>
      parseWalletDump(rawDump({ stores: { coco_cashu_proofs: "nope" } })),
    ).toThrow(/coco_cashu_proofs/)
    expect(() =>
      parseWalletDump(
        rawDump({ stores: { coco_cashu_history: [1, 2, 3] } }),
      ),
    ).toThrow(/coco_cashu_history/)
  })

  it("rejects v2 dumps with no proofs store and v1 dumps missing row lists", () => {
    expect(() =>
      parseWalletDump(rawDump({ stores: { coco_cashu_history: [] } })),
    ).toThrow(/proofs/)
    expect(() => parseWalletDump(rawV1Dump({ proofs: "nope" }))).toThrow(/proofs/)
    expect(() => parseWalletDump(rawV1Dump({ history: [null] }))).toThrow(/history/)
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
