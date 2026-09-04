import { describe, expect, it } from "vitest"

import { DEPOSIT_EXPIRY_MS } from "@/lib/coco/coco-wallet"
import { formatMsRemaining } from "./expiry-countdown"

describe("formatMsRemaining", () => {
  it("formats remaining time as m:ss", () => {
    expect(formatMsRemaining(30 * 60 * 1000)).toBe("30:00")
    expect(formatMsRemaining(1_799_000)).toBe("29:59")
    expect(formatMsRemaining(90_000)).toBe("1:30")
    expect(formatMsRemaining(59_000)).toBe("0:59")
    expect(formatMsRemaining(1_000)).toBe("0:01")
  })

  it("returns null once expired", () => {
    expect(formatMsRemaining(0)).toBeNull()
    expect(formatMsRemaining(-1)).toBeNull()
  })
})

describe("countdown deadline", () => {
  it("falls back to createdAt + the 30-min wallet TTL without expiresAt", () => {
    const createdAt = Date.now() - 10_000
    const deadline = createdAt + DEPOSIT_EXPIRY_MS
    expect(formatMsRemaining(deadline - Date.now())).toMatch(/^29:5/)
  })

  it("prefers the mint's own expiry when present (signut lives 55 min)", () => {
    const createdAt = Date.now() - 10_000
    const expiresAt = createdAt + 55 * 60 * 1000
    const deadline = expiresAt
    expect(formatMsRemaining(deadline - Date.now())).toMatch(/^54:5/)
    // Long after the 30-min fallback would have declared it dead.
    expect(formatMsRemaining(deadline - (createdAt + DEPOSIT_EXPIRY_MS))).toBe(
      "25:00",
    )
  })
})
