import { describe, expect, it, vi } from "vitest"
import { raceTimeout } from "./timeout"

describe("raceTimeout", () => {
  it("passes through the fast path", async () => {
    const p = Promise.resolve(42)
    await expect(raceTimeout(p, 1000, "test")).resolves.toBe(42)
  })

  it("passes through rejection with the original error", async () => {
    const p = Promise.reject(new Error("mint said no"))
    await expect(raceTimeout(p, 1000, "test")).rejects.toThrow("mint said no")
  })

  it("rejects with a named timeout when the promise stalls", async () => {
    vi.useFakeTimers()
    const never = new Promise<number>(() => {})
    const raced = raceTimeout(never, 5000, "melt quote")
    const assertion = expect(raced).rejects.toThrow(
      "Mint request timed out (melt quote)",
    )
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    vi.useRealTimers()
  })

  it("clears the timer on the fast path", async () => {
    vi.useFakeTimers()
    await raceTimeout(Promise.resolve(1), 1000, "test")
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
