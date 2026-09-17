import { describe, expect, it } from "vitest"
import { kwsToCostCents, parseChargeReceipt, refundCents } from "./charge-session"

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

describe("kwsToCostCents (energy pricing, 100 units/kWh)", () => {
  it("converts metered kW·s to cents (1 unit = 36 kW·s)", () => {
    expect(kwsToCostCents(36)).toBe(100)
    expect(kwsToCostCents(72)).toBe(200)
    expect(kwsToCostCents(0)).toBe(0)
  })

  it("rounds to whole cents", () => {
    expect(kwsToCostCents(2)).toBe(6) // 2 * 100/36 = 5.56
    expect(kwsToCostCents(1)).toBe(3) // 2.78
  })

  it("honours alternative tariffs", () => {
    expect(kwsToCostCents(36, 50)).toBe(50)
  })
})

describe("refundCents", () => {
  it("refunds the unspent deposit: budget minus metered cost", () => {
    expect(refundCents(5000, 22)).toBe(4939) // 5000 - round(22*100/36)
    expect(refundCents(400, 2)).toBe(394)
    expect(refundCents(100, 36)).toBe(0) // fully spent budget
  })

  it("leaves sub-unit remainders unclaimed (mint-quote minimum)", () => {
    expect(refundCents(150, 36)).toBe(0) // 150 - 100 = 50c < 1 unit
    expect(refundCents(199, 36)).toBe(0)
    expect(refundCents(200, 36)).toBe(100)
  })

  it("never refunds more than the deposit or below zero", () => {
    expect(refundCents(500, 9999)).toBe(0)
    expect(refundCents(500, 0)).toBe(500)
  })
})
