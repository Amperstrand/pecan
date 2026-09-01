import { useEffect, useState } from "react"
import { TriangleAlert } from "lucide-react"

const CHANNEL_NAME = "pecan-wallet-tabs"

/**
 * Two wallet tabs share one IndexedDB wallet but not live state — spending
 * from both can double-spend proofs the other tab still believes it holds.
 * The hello/ack handshake makes the SECOND tab visible too: the newcomer
 * broadcasts "hello", every listener flags itself and answers "ack", so
 * both sides learn about each other.
 */
export function useMultiTabWarning(): boolean {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL_NAME)
    const onMessage = (event: MessageEvent) => {
      setOpen(true)
      if (event.data === "hello") channel.postMessage("ack")
    }
    channel.addEventListener("message", onMessage)
    channel.postMessage("hello")
    return () => {
      channel.removeEventListener("message", onMessage)
      channel.close()
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
