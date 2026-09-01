import { useEffect, useState } from "react"

import { DEPOSIT_EXPIRY_MS } from "@/lib/coco/coco-wallet"

export function formatMsRemaining(msLeft: number): string | null {
  if (msLeft <= 0) return null
  const totalSeconds = Math.floor(msLeft / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

export function ExpiryCountdown({ createdAt }: { createdAt: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const remaining = formatMsRemaining(createdAt + DEPOSIT_EXPIRY_MS - now)
  if (remaining === null) {
    return (
      <p className="text-sm font-medium">
        Invoice expired — create a new one.
      </p>
    )
  }
  return <p className="text-xs text-muted-foreground">Expires in {remaining}</p>
}
