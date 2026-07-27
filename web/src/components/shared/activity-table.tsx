import type { Ticket } from "@/lib/api"
import { formatAge, formatAmount } from "@/lib/format"
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

export function ActivityTable({
  title,
  tickets,
  now,
  showNotes,
}: {
  title: string
  tickets: Ticket[]
  now: number
  showNotes?: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardAction>
          <span className="text-sm text-muted-foreground">{tickets.length} rows</span>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {tickets.length === 0 ? (
          <EmptyState
            title="No settled operations yet"
            body="Completed deposits and payouts will appear here."
          />
        ) : (
          <Table className="min-w-[560px]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Ticket</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>When</TableHead>
                {showNotes && <TableHead className="pr-6">Notes</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {tickets.map((ticket) => (
                <TableRow key={ticket.id}>
                  <TableCell className="pl-6">
                    <MonoChip>{ticket.short_id}</MonoChip>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {ticket.kind === "incoming" ? "Deposit" : "Payout"}
                  </TableCell>
                  <TableCell className="font-medium">
                    {formatAmount(ticket.amount, ticket.unit)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={ticket.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatAge(ticket.paid_at ?? ticket.created_at, now)}
                  </TableCell>
                  {showNotes && (
                    <TableCell className="max-w-[24ch] truncate pr-6 text-muted-foreground">
                      {ticket.notes ?? "-"}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
