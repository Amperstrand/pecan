import { toast } from "sonner"

import { ApiRequestError, fetchSnapshot } from "@/lib/api"
import { navigate } from "@/lib/router"

/**
 * Config mutations persist and then exit the process ~900 ms after responding;
 * Docker restarts it. Instead of a blind full-page reload, wait for /api/app
 * to answer again and refresh in place. Sessions persist server-side, so the
 * operator stays signed in across the restart.
 */
export async function awaitRestart(opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 45_000
  const started = Date.now()
  await sleep(1500)
  let delay = 700
  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("The service did not come back in time. Reload the page to reconnect.")
    }
    try {
      await fetchSnapshot()
      return
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        navigate("/login")
        throw new Error("Signed out during the restart. Sign in again.")
      }
      // Network errors and gateway 5xx while the process is down: keep polling.
    }
    await sleep(delay)
    delay = Math.min(Math.round(delay * 1.3), 3000)
  }
}

export async function runRestartingMutation(
  label: string,
  fn: () => Promise<unknown>,
  refresh: () => Promise<void>,
): Promise<void> {
  const id = toast.loading(label)
  try {
    await fn()
    await awaitRestart()
    await refresh()
    toast.success("Configuration applied", { id })
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "The change could not be applied.", { id })
    throw err
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
