import { useEffect, useState } from "react"

import { DEPOSIT_EXPIRY_MS } from "@/lib/coco/coco-wallet"

export function formatMsRemaining(msLeft: number): string | null {
  if (msLeft <= 0) return null
  const totalSeconds = Math.floor(msLeft / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

/**
 * Invoice/quote life countdown. `expiresAt` (the mint's own expiry,
 * epoch ms) wins when present — quote TTLs differ per mint (fiat pairs
 * 30 min, signut 55) — else the 30-min wallet-side fallback applies.
 */
export function ExpiryCountdown({
  createdAt,
  expiresAt,
}: {
  createdAt: number
  expiresAt?: number
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const deadline = expiresAt ?? createdAt + DEPOSIT_EXPIRY_MS
  const remaining = formatMsRemaining(deadline - now)
  if (remaining === null) {
    return (
      <p className="text-sm font-medium">
        Invoice expired — create a new one.
      </p>
    )
  }
  return <p className="text-xs text-muted-foreground">Expires in {remaining}</p>
}
