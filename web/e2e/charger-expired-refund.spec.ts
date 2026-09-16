import { execSync } from "node:child_process"
import { test, expect, type Page } from "@playwright/test"
import { bootAndFund } from "./helpers/ev-rail"
import {
  apiLogin,
  expectNoWalletWarnsSince,
  readBalance,
  readWalletDb,
  waitForOpState,
} from "./helpers/wallet"

// Issue #13, the honest repro: kill the EUR payout daemon, let a real
// deposit melt EXPIRE (fiat quotes live 30 min), restart — the daemon
// must distinguish this never-triggered melt from a delivered partial
// and auto-refund it: mark-failed → the mint's PaymentFailed rollback
// releases the burned proofs → the wallet's op rolls back and the
// balance is whole again, surfaced as an explicit refund card.
//
// @expiry: excluded from the default lane (scripts/e2e.sh) because the
// quote TTL alone costs ~30 minutes of wall time; run explicitly with
//   scripts/e2e.sh -g @expiry
const SERVER = "root@46.224.104.12"
const BUDGET = 2

function ssh(cmd: string): string {
  return execSync(`ssh -o ConnectTimeout=10 ${SERVER} "${cmd}"`, {
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString()
}

interface EvTicket {
  id: string
  status: string
  expires_at: number
}

async function fundedEvTicket(page: Page): Promise<EvTicket> {
  const resp = await page.request.get("/eur-console/api/tickets/open?rail=ev")
  const tickets = (await resp.json()) as EvTicket[]
  return tickets.find((x) => x.status !== "waiting") ?? tickets[0]
}

test("expired never-triggered deposit auto-refunds (@expiry)", async ({ page }) => {
  test.setTimeout(40 * 60_000)
  const sinceT = Date.now()

  ssh("systemctl stop ev-charge")
  let daemonStopped = true
  try {
    await bootAndFund(page, "/eur-console", BUDGET + 1)
    await apiLogin(page, "/eur-console")
    const before = await readBalance(page)

    await page.getByRole("tab", { name: "Charger C", exact: true }).click()
    await page.getByPlaceholder("1.00").fill(String(BUDGET))
    await page.getByRole("button", { name: "Start charging" }).click()

    // The melt locked funds (ticket left `waiting`) and nothing will ever
    // trigger it — the daemon is down, so no charge card ever appears
    // (startCharging only renders one once the gateway reports a
    // session); the console ticket IS the fund-lock truth. Ride out the
    // quote's full TTL from here.
    await expect
      .poll(async () => (await fundedEvTicket(page))?.status ?? "waiting", {
        timeout: 90_000,
      })
      .not.toBe("waiting")
    const ticket = await fundedEvTicket(page)
    expect(ticket.status).not.toBe("waiting")
    const tail = ticket.id.slice(-6).toUpperCase()
    const expiresAtMs = Number(ticket.expires_at) * 1000
    while (Date.now() < expiresAtMs + 10_000) {
      await page.waitForTimeout(30_000)
    }

    // Restart: the watch loop's expiry guard must mark-fail this
    // never-triggered melt and journal the refund.
    ssh("systemctl start ev-charge")
    daemonStopped = false
    await expect
      .poll(
        () =>
          Number(
            ssh(
              "journalctl -u ev-charge --since=-3min -o cat " +
                "| grep -c refund-issued || true",
            ).trim() || "0",
          ),
        { timeout: 90_000 },
      )
      .toBeGreaterThanOrEqual(1)

    // Reload the wallet: the pending charge card resolves into the
    // explicit refund (the melt op rolls back, proofs return).
    await page.reload()
    await expect(
      page.getByText(/Refunded .* back in your balance/),
    ).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText(/never started/)).toBeVisible()

    await waitForOpState(page, "melt", tail, "rolled_back", 120_000)
    const db = await readWalletDb(page)
    expect(db.proofCount).toBeGreaterThan(0)

    await expect
      .poll(async () => readBalance(page), { timeout: 120_000 })
      .toBeCloseTo(before, 2)
  } finally {
    if (daemonStopped) {
      ssh("systemctl start ev-charge")
    }
  }

  // The no-warn gate over the whole saga (reload resets the ring buffer;
  // epoch filtering keeps only what this test generated).
  await expectNoWalletWarnsSince(page, sinceT)
})
