import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
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
