import { describe, expect, it } from "vitest"
import { kwsToCostCents, parseChargeReceipt, PRICE_PER_KWH, refundCents } from "./charge-session"

describe("parseChargeReceipt", () => {
  it("parses a delivered session record", () => {
    expect(parseChargeReceipt("EV-atomA-3s-54F6C90C")).toEqual({
      device: "atomA",
      deliveredSeconds: 3,
      stopped: false,
    })
  })

  it("parses a stopped session record", () => {
    expect(parseChargeReceipt("EV-atomB-1s-DE0245CB-STOPPED")).toEqual({
      device: "atomB",
      deliveredSeconds: 1,
      stopped: true,
    })
  })

  it("rejects foreign receipts", () => {
    expect(parseChargeReceipt("SIM-1234ABCD")).toBeNull()
    expect(parseChargeReceipt("E2E-260901-AB12CD34")).toBeNull()
    expect(parseChargeReceipt("PAID")).toBeNull()
    expect(parseChargeReceipt("")).toBeNull()
  })
})

describe(`kwsToCostCents (energy pricing, ${PRICE_PER_KWH} units/kWh)`, () => {
  it("converts metered kW·s to cents (1 unit = 36/price kW·s)", () => {
    // €0.50/kWh: 7200 kW·s per unit — a real short session bills cents.
    expect(kwsToCostCents(7200)).toBe(100)
    expect(kwsToCostCents(14400)).toBe(200)
    expect(kwsToCostCents(0)).toBe(0)
  })

  it("rounds to whole cents", () => {
    expect(kwsToCostCents(72)).toBe(1) // 1.0 exactly
    expect(kwsToCostCents(360)).toBe(5) // 5.0
    expect(kwsToCostCents(36)).toBe(1) // 0.5 rounds up
    expect(kwsToCostCents(35)).toBe(0) // 0.486 rounds down
  })

  it("honours alternative tariffs", () => {
    expect(kwsToCostCents(36, 50)).toBe(50)
  })
})

describe("refundCents", () => {
  it("refunds the unspent deposit: budget minus metered cost", () => {
    expect(refundCents(5000, 340)).toBe(4995) // 5000 - round(340*0.5/36) = 5 cents
    expect(refundCents(400, 72)).toBe(399)
    expect(refundCents(100, 7200)).toBe(0) // fully spent budget
  })

  it("leaves sub-unit remainders unclaimed (mint-quote minimum)", () => {
    expect(refundCents(150, 7200)).toBe(0) // 150 - 100 = 50c < 1 unit
    expect(refundCents(199, 7200)).toBe(0)
    expect(refundCents(200, 7200)).toBe(100)
  })

  it("never refunds more than the deposit or below zero", () => {
    expect(refundCents(500, 999999)).toBe(0)
    expect(refundCents(500, 0)).toBe(500)
  })
})
