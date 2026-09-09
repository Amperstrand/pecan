import base from "./playwright.config"
import { defineConfig } from "@playwright/test"

export default defineConfig({
  ...base,
  use: {
    ...base.use,
    video: { mode: "on", size: { width: 420, height: 900 } },
    // instrumented runs are for humans watching — headless on demand.
    // The next two + the launch arg exist so the wallet page (public
    // https, strict CSP — correct in production) can frame the LOCAL
    // charger-sim mirror for the demo: bypassCSP for frame-src,
    // ignoreHTTPSErrors for the self-signed local cert (base sets it
    // already), and --disable-web-security for Chrome's private-network
    // blocking of public→localhost iframes. DEMO HARNESS ONLY — never
    // copy these into a real browsing or test context.
    headless: process.env.PECAN_HEADLESS === "1",
    bypassCSP: true,
    launchOptions: { args: ["--disable-web-security"] },
  },
  outputDir: "./e2e/.results-video",
})
