import { X } from "lucide-react"

import type { KeysetEntry, TicketStatus } from "@/lib/api"
import { Badge } from "@/components/ui/badge"

/** Grayscale ticket status: solid = paid, outline = in progress, X = failed. */
export function StatusBadge({ status }: { status: TicketStatus }) {
  if (status === "paid") return <Badge variant="solid">Paid</Badge>
  if (status === "failed")
    return (
      <Badge variant="outline">
        <X />
        Failed
      </Badge>
    )
  const label = status === "waiting" ? "Awaiting wallet" : "Open"
  return <Badge variant="outline">{label}</Badge>
}

export function KeysetBadge({ keyset, now }: { keyset: KeysetEntry; now: number }) {
  const expired = keyset.final_expiry != null && keyset.final_expiry <= now
  if (expired)
    return (
      <Badge variant="outline">
        <X />
        Expired
      </Badge>
    )
  if (keyset.active) return <Badge variant="solid">Active</Badge>
  return <Badge variant="muted">Inactive</Badge>
}
