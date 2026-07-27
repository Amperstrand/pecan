import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { markFailed, markPaid, type Ticket } from "@/lib/api"
import { formatAge, formatAmount } from "@/lib/format"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { StatusBadge } from "@/components/shared/badges"
import { MonoChip } from "@/components/shared/bits"
import { ActionPair } from "@/components/teller/action-pair"
import { OfferPanel } from "@/components/teller/offer-panel"

/**
 * One card per teller state. Interaction contract: at most two big buttons —
 * interrupt (outline, left) and proceed (solid, right). Proceed exists only in
 * `pending`, the single status the server's mark-paid accepts. SSE refreshes
 * advance the card as the wallet acts (offered → waiting → pending).
 */
export function ActiveTicketCard({
  ticket,
  now,
  onRefresh,
}: {
  ticket: Ticket
  now: number
  onRefresh: () => Promise<void>
}) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState<"proceed" | "interrupt" | null>(null)

  const incoming = ticket.kind === "incoming"
  const offered = ticket.status === "offered"
  const waiting = ticket.status === "waiting"
  const pending = ticket.status === "pending"
  const expired = offered && ticket.expires_at != null && ticket.expires_at <= now
  const title = incoming ? "Deposit" : "Withdrawal"

  async function settle(kind: "paid" | "failed", settledToast: string) {
    setBusy(kind === "paid" ? "proceed" : "interrupt")
    try {
      if (kind === "paid") {
        await markPaid(ticket.id, note || undefined)
      } else {
        await markFailed(ticket.id, note || undefined)
      }
      setNote("")
      await onRefresh()
      toast(settledToast)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the quote.")
    } finally {
      setBusy(null)
    }
  }

  const amountText = formatAmount(ticket.amount, ticket.unit)

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {title} · {amountText}
        </CardTitle>
        <CardAction>
          <StatusBadge status={ticket.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5">
        {offered && <OfferPanel ticket={ticket} now={now} expired={expired} />}

        {waiting && (
          <div className="grid gap-3">
            <Alert variant="emphasis">
              <Loader2 className="animate-spin" />
              <AlertTitle>The wallet is committing funds. Do not pay out yet.</AlertTitle>
              <AlertDescription>This screen updates automatically.</AlertDescription>
            </Alert>
          </div>
        )}

        {pending && incoming && (
          <div className="grid justify-items-center gap-3 py-2 text-center">
            <div className="text-4xl font-semibold tabular-nums">{amountText}</div>
            <p className="m-0 max-w-[44ch] text-sm text-muted-foreground">
              Take <strong className="text-foreground">{amountText}</strong> in cash from the
              customer, then confirm.
            </p>
          </div>
        )}

        {pending && !incoming && (
          <div className="grid justify-items-center gap-3 py-2 text-center">
            <div className="rounded-lg border bg-muted px-6 py-4 font-mono text-4xl font-semibold tracking-[0.3em]">
              {ticket.verification_code ?? "——————"}
            </div>
            <p className="m-0 max-w-[46ch] text-sm text-muted-foreground">
              The customer's wallet shows this code. If it matches, pay out{" "}
              <strong className="text-foreground">{amountText}</strong> in cash.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            Ticket <MonoChip>{ticket.short_id}</MonoChip>
          </span>
          <span>Created {formatAge(ticket.created_at, now)}</span>
          {ticket.description && <span>Note: {ticket.description}</span>}
        </div>

        <Separator />

        <div className="grid gap-3">
          {pending && (
            <Input
              className="max-w-sm text-sm"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Receipt note (optional)"
            />
          )}
          {offered && (
            <ActionPair
              interruptLabel={expired ? "Discard offer" : "Cancel offer"}
              onInterrupt={() => void settle("failed", "Offer cancelled")}
              busy={busy}
            />
          )}
          {waiting && (
            <ActionPair
              interruptLabel="Cancel quote"
              onInterrupt={() => void settle("failed", "Quote cancelled")}
              busy={busy}
            />
          )}
          {pending && incoming && (
            <ActionPair
              interruptLabel="Void deposit"
              onInterrupt={() => void settle("failed", "Deposit voided")}
              proceedLabel="Cash received"
              onProceed={() => void settle("paid", `Deposit settled — ${amountText}`)}
              busy={busy}
            />
          )}
          {pending && !incoming && (
            <ActionPair
              interruptLabel="Mark failed"
              onInterrupt={() => void settle("failed", "Payout marked failed")}
              proceedLabel="Cash paid out"
              onProceed={() => void settle("paid", `Payout settled — ${amountText}`)}
              busy={busy}
            />
          )}
        </div>
      </CardContent>
    </Card>
  )
}
