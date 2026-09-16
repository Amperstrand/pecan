import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // Playwright's default actionTimeout is 0 (no limit): an action on a
  // missing element silently consumes the whole test budget — a hung fill
  // once burned a 420s timeout with no error line pointing at the action.
  // Every action and navigation must fail on its own, fast.
  actionTimeout: 15_000,
  navigationTimeout: 20_000,
  expect: { timeout: 10_000 },
  // Hard ceiling for a run. The default suite's worst observed: 14.9m —
  // a runaway run must die before it eats the soak budget. The @expiry
  // lane (charger-expired-refund.spec.ts) legitimately spends a full
  // 30-minute quote TTL waiting for the melt to expire, so the ceiling
  // must clear it: run it alone with `scripts/e2e.sh -g @expiry`.
  globalTimeout: 75 * 60_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    baseURL: "https://giftcard.cashu.exchange",
    headless: true,
    viewport: { width: 420, height: 900 },
    ignoreHTTPSErrors: true,
  },
  outputDir: "./e2e/.results",
  reporter: [["list"]],
})
