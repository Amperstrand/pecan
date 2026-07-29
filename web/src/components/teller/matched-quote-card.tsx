import { useState } from "react"
import { Loader2, X } from "lucide-react"
import { toast } from "sonner"

import { markFailed, markPaid, type Ticket } from "@/lib/api"
import { formatAge, formatAmount, formatCountdown } from "@/lib/format"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { StatusBadge } from "@/components/shared/badges"
import { MonoChip } from "@/components/shared/bits"
import { ActionPair } from "@/components/teller/action-pair"

/**
 * The confirm card for a matched quote. Interaction contract: at most two big
 * buttons — interrupt (outline, left) and proceed (solid, right). Proceed
 * exists only in `pending`, the single status the server's mark-paid accepts.
 * SSE refreshes advance the card as the wallet acts (waiting → pending).
 */
export function MatchedQuoteCard({
  ticket,
  now,
  onDismiss,
  onSettled,
}: {
  ticket: Ticket
  now: number
  onDismiss: () => void
  onSettled: () => Promise<void>
}) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState<"proceed" | "interrupt" | null>(null)

  const incoming = ticket.kind === "incoming"
  const waiting = ticket.status === "waiting"
  const pending = ticket.status === "pending"
  const title = incoming ? "Deposit" : "Withdrawal"
  const amountText = formatAmount(ticket.amount, ticket.unit)
  const expiresIn =
    ticket.expires_at != null && ticket.expires_at > now
      ? formatCountdown(ticket.expires_at, now)
      : null

  async function settle(kind: "paid" | "failed", settledToast: string) {
    setBusy(kind === "paid" ? "proceed" : "interrupt")
    try {
      if (kind === "paid") {
        await markPaid(ticket.id, note || undefined)
      } else {
        await markFailed(ticket.id, note || undefined)
      }
      setNote("")
      await onSettled()
      toast(settledToast)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the quote.")
    } finally {
      setBusy(null)
    }
  }

  const quoteId = ticket.quote_id ?? ticket.id
  const idHead = quoteId.slice(0, Math.max(quoteId.length - 6, 0))
  const idTail = quoteId.slice(Math.max(quoteId.length - 6, 0))

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {title} · {amountText}
        </CardTitle>
        <CardAction className="flex items-center gap-2">
          <StatusBadge status={ticket.status} />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss"
            disabled={busy !== null}
            onClick={onDismiss}
          >
            <X />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid justify-items-center gap-1 text-center">
          <span className="text-xs text-muted-foreground uppercase tracking-wide">Quote</span>
          <span className="break-all font-mono text-sm text-muted-foreground">
            {idHead}
            <strong className="text-foreground">{idTail}</strong>
          </span>
          <p className="m-0 max-w-[46ch] text-xs text-muted-foreground">
            Check the highlighted characters against the customer's wallet before settling.
          </p>
        </div>

        {waiting && (
          <Alert variant="emphasis">
            <Loader2 className="animate-spin" />
            <AlertTitle>The wallet is committing funds. Do not pay out yet.</AlertTitle>
            <AlertDescription>This screen updates automatically.</AlertDescription>
          </Alert>
        )}

        {pending && (
          <div className="grid justify-items-center gap-3 py-2 text-center">
            <div className="text-4xl font-semibold tabular-nums">{amountText}</div>
            <p className="m-0 max-w-[44ch] text-sm text-muted-foreground">
              {incoming ? (
                <>
                  Take <strong className="text-foreground">{amountText}</strong> in cash from
                  the customer, then confirm.
                </>
              ) : (
                <>
                  The ecash is locked at the mint. Pay out{" "}
                  <strong className="text-foreground">{amountText}</strong> in cash, then
                  confirm.
                </>
              )}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            Ticket <MonoChip>{ticket.short_id}</MonoChip>
          </span>
          <span>Created {formatAge(ticket.created_at, now)}</span>
          {incoming && expiresIn && <span>Expires in {expiresIn}</span>}
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
          {waiting && (
            <ActionPair
              interruptLabel="Void quote"
              onInterrupt={() => void settle("failed", "Quote voided")}
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
