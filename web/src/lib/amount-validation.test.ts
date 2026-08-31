import { describe, expect, it } from "vitest"

import {
  MAX_AMOUNT,
  MIN_ONCHAIN_DEPOSIT,
  validateDepositAmount,
  validateWithdrawAmount,
} from "./amount-validation"

describe("validateDepositAmount", () => {
  const sym = "€"

  it("rejects empty / non-numeric / non-positive input", () => {
    expect(validateDepositAmount("", "branch", sym)).toContain("Enter an amount")
    expect(validateDepositAmount("abc", "branch", sym)).toContain("Enter an amount")
    expect(validateDepositAmount("0", "branch", sym)).toContain("Enter an amount")
    expect(validateDepositAmount("-5", "branch", sym)).toContain("Enter an amount")
  })

  it("enforces the 1.00 minimum on branch and ln rails", () => {
    expect(validateDepositAmount("0.99", "branch", sym)).toContain("at least 1")
    expect(validateDepositAmount("0.99", "ln", sym)).toContain("at least 1")
    expect(validateDepositAmount("1", "branch", sym)).toBeNull()
    expect(validateDepositAmount("1.00", "ln", sym)).toBeNull()
  })

  it("enforces the on-chain minimum only on the btc rail", () => {
    expect(validateDepositAmount("49.99", "btc", sym)).toContain(
      `at least ${MIN_ONCHAIN_DEPOSIT}`,
    )
    expect(validateDepositAmount("50", "btc", sym)).toBeNull()
    // same amount is fine on the other rails
    expect(validateDepositAmount("49.99", "ln", sym)).toBeNull()
  })

  it("rejects amounts above the mint maximum (the 1231234 regression)", () => {
    expect(validateDepositAmount("1231234", "branch", sym)).toContain(
      `above ${MAX_AMOUNT}`,
    )
    expect(validateDepositAmount("1000.01", "ln", sym)).toContain(`above ${MAX_AMOUNT}`)
    expect(validateDepositAmount("1000", "btc", sym)).toBeNull()
  })
})

describe("validateWithdrawAmount", () => {
  const sym = "$"

  it("rejects empty / non-numeric / non-positive input", () => {
    expect(validateWithdrawAmount("", sym, null)).toContain("Enter an amount")
    expect(validateWithdrawAmount("nope", sym, 10_000)).toContain("Enter an amount")
  })

  it("enforces min and max", () => {
    expect(validateWithdrawAmount("0.5", sym, null)).toContain("at least 1")
    expect(validateWithdrawAmount("1001", sym, null)).toContain("above 1000")
    expect(validateWithdrawAmount("5", sym, null)).toBeNull()
  })

  it("checks the balance when it is loaded", () => {
    expect(validateWithdrawAmount("6", sym, 500)).toContain("exceeds your balance")
    expect(validateWithdrawAmount("5", sym, 500)).toBeNull()
    // null balance = not loaded yet; skip the client-side check
    expect(validateWithdrawAmount("6", sym, null)).toBeNull()
  })
})
