import { useEffect, useState } from "react"
import { TriangleAlert } from "lucide-react"

const LOCK_NAME = "pecan-wallet-tab"
const POLL_MS = 2000

/**
 * Two wallet tabs share one IndexedDB wallet but not live state — spending
 * from both can double-spend proofs the other tab still believes it holds.
 *
 * Every tab requests the same Web Lock and holds it forever; a second tab's
 * request queues. navigator.locks.query() therefore counts exactly one
 * entry per live tab (held or pending), releases are automatic on tab
 * close/crash, and the poll clears the warning when the other tab goes
 * away — unlike a BroadcastChannel ping, which cannot observe closures.
 */
export function useMultiTabWarning(): boolean {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!("locks" in navigator)) return
    let cancelled = false
    void navigator.locks.request(LOCK_NAME, () => new Promise<void>(() => {}))
    const poll = async () => {
      if (cancelled) return
      const snapshot = await navigator.locks.query().catch(() => null)
      if (cancelled || snapshot === null) return
      const entries = [...(snapshot.held ?? []), ...(snapshot.pending ?? [])]
      setOpen(entries.filter((lock) => lock.name === LOCK_NAME).length > 1)
    }
    void poll()
    const id = setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return open
}

export function MultiTabBanner({ visible }: { visible: boolean }) {
  if (!visible) return null
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border p-3 text-sm"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <p>
        This wallet is open in another tab. Close one of them — spending
        from both tabs can lose money.
      </p>
    </div>
  )
}
