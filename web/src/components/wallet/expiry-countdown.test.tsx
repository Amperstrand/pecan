import { describe, expect, it } from "vitest"

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
