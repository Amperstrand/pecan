import type { Ticket } from "@/lib/api"
import { formatCountdown } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { CopyButton } from "@/components/shared/bits"

/**
 * The NUT-XX quote offer: QR (kept on a white plate so it scans in dark mode)
 * plus the serialized `cquoteA…` string with a copy button and a live
 * countdown. The offer is single-use; the wallet claims it by creating its
 * own quote, so no quote ID ever appears on this screen.
 */
export function OfferPanel({
  ticket,
  now,
  expired,
}: {
  ticket: Ticket
  now: number
  expired: boolean
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
      <div className="grid min-w-0 content-start gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{expired ? "Expired" : "Waiting for wallet"}</Badge>
          {!expired && ticket.expires_at != null && (
            <span className="text-sm tabular-nums text-muted-foreground">
              Expires in {formatCountdown(ticket.expires_at, now)}
            </span>
          )}
        </div>
        {expired && (
          <p className="m-0 text-sm text-muted-foreground">No wallet claimed this offer.</p>
        )}
        {ticket.offer && (
          <div className="flex min-w-0 items-start gap-2">
            <div className="max-h-28 min-w-0 flex-1 overflow-y-auto break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
              {ticket.offer}
            </div>
            <CopyButton value={ticket.offer} label="Copy quote offer" />
          </div>
        )}
      </div>
      <div
        className={cn(
          "grid place-items-center rounded-lg border bg-white p-3 [&_svg]:block [&_svg]:h-auto [&_svg]:w-full",
          expired && "opacity-40",
        )}
      >
        {ticket.qr_svg ? (
          <div className="w-full" dangerouslySetInnerHTML={{ __html: ticket.qr_svg }} />
        ) : (
          <div className="grid aspect-square w-full place-items-center text-sm text-neutral-500">
            No offer
          </div>
        )}
      </div>
    </div>
  )
}
