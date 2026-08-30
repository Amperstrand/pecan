import { describe, expect, it } from "vitest"
import { Amount } from "@cashu/cashu-ts"
import type { HistoryEntry } from "@cashu/coco-core"
import { fromHex, mapHistoryEntry, toHex } from "./coco-wallet"

function historyFixture(fields: {
  type: string
  state: string
  amount: number
}): HistoryEntry {
  return {
    ...fields,
    createdAt: Date.now() - 1000,
    amount: Amount.from(fields.amount),
  } as unknown as HistoryEntry
}

describe("mapHistoryEntry", () => {
  it("maps finalized mint entries to completed deposits", () => {
    const row = mapHistoryEntry(historyFixture({ type: "mint", state: "finalized", amount: 500 }))
    expect(row).toMatchObject({ type: "deposit", amount_cents: 500, pending: false })
  })

  it("marks non-finalized mint entries as pending", () => {
    for (const state of ["prepared", "pending", "executing"]) {
      const row = mapHistoryEntry(historyFixture({ type: "mint", state, amount: 500 }))
      expect(row).toMatchObject({ type: "deposit", pending: true })
    }
  })

  it("drops failed mint entries entirely", () => {
    expect(mapHistoryEntry(historyFixture({ type: "mint", state: "failed", amount: 500 }))).toBeNull()
  })

  it("maps melt entries and marks only finalized ones complete", () => {
    expect(
      mapHistoryEntry(historyFixture({ type: "melt", state: "finalized", amount: 500 })),
    ).toMatchObject({ type: "withdraw", amount_cents: 500, pending: false })
    expect(
      mapHistoryEntry(historyFixture({ type: "melt", state: "executing", amount: 500 })),
    ).toMatchObject({ type: "withdraw", pending: true })
  })

  it("returns null for unrelated entry types", () => {
    expect(mapHistoryEntry(historyFixture({ type: "send", state: "finalized", amount: 1 }))).toBeNull()
  })
})

describe("seed hex helpers", () => {
  it("roundtrips bytes through hex", () => {
    const seed = new Uint8Array(64)
    for (let i = 0; i < seed.length; i++) seed[i] = (i * 37) % 256
    expect(fromHex(toHex(seed))).toEqual(seed)
    expect(toHex(seed)).toHaveLength(128)
  })

  it("parses hex pairs into bytes", () => {
    expect(Array.from(fromHex("00ff7f"))).toEqual([0, 255, 127])
  })
})
