import { execSync, spawn, type ChildProcess } from "node:child_process"
import { test, expect } from "@playwright/test"
import { readBalance, readTellerCode } from "./helpers/wallet"

// The EV rail end to end: melt `ev:<device>` ecash → ev-charge adapter →
// device gateway (the fake one until the Atom is back) → session window →
// mark-paid with the session receipt. Zero sat; the charge window is
// shrunk via --secs-per-eur to keep the test fast.
let gateway: ChildProcess | null = null

test.afterAll(() => gateway?.kill())

test("ev rail: melt buys a charge session with a session receipt", async ({ page }) => {
  test.setTimeout(180_000)
  const consoleBase = "/eur-console"
  const password = process.env.PECAN_ADMIN_PASSWORD
  test.skip(!password, "admin password unavailable")

  // Ephemeral port (0 = let the OS pick) read back from the startup line —
  // a fixed port collides with leaked gateways from failed runs.
  gateway = spawn("python3", ["../payout/ev-device-fake.py", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  const gatewayLogs: string[] = []
  gateway.stdout!.on("data", (d) => gatewayLogs.push(String(d)))
  const gatewayPort = await new Promise<number>((resolve, reject) => {
    const deadline = Date.now() + 10_000
    const poll = () => {
      const m = gatewayLogs.join("").match(/127\.0\.0\.1:(\d+)/)
      if (m) return resolve(Number(m[1]))
      if (Date.now() > deadline) return reject(new Error("fake gateway never started"))
      setTimeout(poll, 200)
    }
    poll()
  })

  await page.addInitScript(() => {
    window.localStorage.setItem("pecan-debug", "1")
    window.localStorage.setItem("pecan-currency", "eur")
  })
  await page.goto(`${consoleBase}/wallet`)
  await expect(page.getByRole("heading", { name: "Wallet" })).toBeVisible()

  // Self-fund through the teller rail if needed.
  let balance = await readBalance(page)
  if (balance < 5) {
    await page.getByPlaceholder("5.00").fill("5")
    await page.getByRole("button", { name: "Create deposit quote" }).click()
    const depCode = await readTellerCode(page)
    const { apiLogin, matchAndSettle } = await import("./helpers/wallet")
    await apiLogin(page, consoleBase, password)
    await matchAndSettle(page, depCode, "ev rail funding", consoleBase)
    await expect
      .poll(async () => readBalance(page), { timeout: 45_000 })
      .toBeGreaterThanOrEqual(5)
  }

  const before = await readBalance(page)
  // Raw envelope in the teller field — the picker entry ships with the
  // hardware; the envelope path works today.
  await page.getByPlaceholder("Phone or reference").fill("ev:atom-fake")
  await page.getByPlaceholder("1.00").fill("1")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const code = await readTellerCode(page)

  const out = execSync(
    `python3 ../payout/ev-charge.py --base ${new URL(page.url()).origin}${consoleBase} ` +
      `--password "${password}" --code ${code} ` +
      `--gateway http://127.0.0.1:${gatewayPort} --secs-per-eur 5`,
    { timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
  ).toString()
  const settled = JSON.parse(out.trim().split("\n").pop()!) as {
    result: string
    device: string
    seconds: number
    receipt: string
  }
  expect(settled.result).toBe("settled")
  expect(settled.device).toBe("atom-fake")
  expect(settled.seconds).toBe(5)

  // The wallet surfaces the session record where Lightning shows preimages.
  await expect(page.getByText(/^EV-atom-fake-5s-[0-9A-F]{8}$/)).toBeVisible({
    timeout: 30_000,
  })
  await expect
    .poll(async () => readBalance(page), { timeout: 60_000 })
    .toBeCloseTo(before - 1, 2)
  expect(gatewayLogs.join("")).toContain("trigger atom-fake seconds=5")
})
