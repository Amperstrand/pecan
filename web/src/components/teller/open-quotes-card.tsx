import type { OpenQuoteSummary } from "@/lib/api"
import { formatAge, formatAmount, formatExpiry } from "@/lib/format"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { StatusBadge } from "@/components/shared/badges"
import { EmptyState, MonoChip } from "@/components/shared/bits"

/**
 * Read-only situational awareness: which wallet-created quotes are open right
 * now. Ids arrive truncated from the server (leading characters only) — the
 * rows are deliberately not actionable, settling always goes through the
 * match input with a code from the customer's wallet.
 */
export function OpenQuotesCard({
  quotes,
  now,
}: {
  quotes: OpenQuoteSummary[]
  now: number
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Open quotes</CardTitle>
        <CardAction>
          <span className="text-sm text-muted-foreground">{quotes.length} open</span>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {quotes.length === 0 ? (
          <EmptyState
            title="No open quotes"
            body="Customers create quotes in their wallet; they appear here."
          />
        ) : (
          <Table className="min-w-[560px]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Quote</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="pr-6">Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quotes.map((quote, index) => (
                <TableRow key={`${quote.prefix}-${index}`}>
                  <TableCell className="pl-6">
                    <MonoChip>{quote.prefix}…</MonoChip>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {quote.kind === "incoming" ? "Deposit" : "Payout"}
                  </TableCell>
                  <TableCell className="font-medium">
                    {formatAmount(quote.amount, quote.unit)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={quote.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatAge(quote.created_at, now)}
                  </TableCell>
                  <TableCell className="pr-6 text-muted-foreground">
                    {formatExpiry(quote.expires_at, now)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
