import { describe, expect, it } from "vitest"
import { parseChargeReceipt, refundEuros } from "./charge-session"

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

describe("refundEuros", () => {
  it("refunds the unspent deposit at the 1 s/€ demo tariff", () => {
    expect(refundEuros(50, 50)).toBe(0)
    expect(refundEuros(50, 12)).toBe(38)
    expect(refundEuros(3, 1)).toBe(2)
  })

  it("floors sub-euro remainders (mint-quote minimum)", () => {
    expect(refundEuros(3, 2)).toBe(1)
    expect(refundEuros(1, 0)).toBe(1)
    expect(refundEuros(2, 2)).toBe(0)
  })

  it("never refunds more than the deposit or below zero", () => {
    expect(refundEuros(5, 99)).toBe(0)
    expect(refundEuros(5, 0)).toBe(5)
  })

  it("honours alternative tariffs", () => {
    expect(refundEuros(10, 10, 5)).toBe(8)
  })
})
