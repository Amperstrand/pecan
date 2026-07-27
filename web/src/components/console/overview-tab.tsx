import { CircleAlert, CircleCheck, CircleDot, Wallet } from "lucide-react"

import type { AppSnapshot, HealthItem } from "@/lib/api"
import { formatSignedAmount } from "@/lib/format"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { ActivityTable } from "@/components/shared/activity-table"
import { LifecycleBadge } from "@/components/shared/badges"
import { CirculationChart } from "@/components/shared/circulation-chart"
import { StatTile } from "@/components/shared/stat-tile"

export function OverviewTab({ snapshot }: { snapshot: AppSnapshot }) {
  const health: Array<[string, HealthItem]> = [
    ["Mint HTTP", snapshot.health.mint_http],
    ["Management RPC", snapshot.health.management_rpc],
    ["Payment backend", snapshot.health.payment_backend],
  ]

  return (
    <div className="grid gap-4">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {health.map(([label, item]) => (
          <StatTile
            key={label}
            label={label}
            value={item.label}
            detail={item.detail}
            icon={item.ok ? <CircleCheck /> : <CircleAlert />}
          />
        ))}
        <StatTile
          label={`Circulation · ${snapshot.mint.unit.toUpperCase()}`}
          value={formatSignedAmount(snapshot.summary.net_issued, snapshot.mint.unit)}
          detail="Completed deposits minus completed payouts"
          icon={<Wallet />}
        />
        <StatTile
          label="Active quotes"
          value={String(snapshot.active_tickets.length)}
          detail="Waiting or pending teller work"
          icon={<CircleDot />}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Circulating ecash</CardTitle>
          <CardDescription>Net issued balance over settled activity.</CardDescription>
        </CardHeader>
        <CardContent>
          <CirculationChart data={snapshot.circulation} unit={snapshot.mint.unit} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Unit balances</CardTitle>
            <CardDescription>Values from unlike units are never summed.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table className="min-w-[480px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Unit</TableHead>
                  <TableHead>Lifecycle</TableHead>
                  <TableHead>Deposits</TableHead>
                  <TableHead>Payouts</TableHead>
                  <TableHead className="pr-6">Net issued</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.unit_summaries.map((summary) => {
                  const managed = snapshot.units.find((unit) => unit.unit === summary.unit)
                  return (
                    <TableRow key={summary.unit}>
                      <TableCell className="pl-6 font-mono font-medium uppercase">
                        {summary.unit}
                      </TableCell>
                      <TableCell>
                        {managed ? (
                          <LifecycleBadge lifecycle={managed.lifecycle} />
                        ) : (
                          <Badge variant="muted">Observed</Badge>
                        )}
                      </TableCell>
                      <TableCell>{summary.mint_count}</TableCell>
                      <TableCell>{summary.melt_count}</TableCell>
                      <TableCell className="pr-6 font-mono">
                        {formatSignedAmount(summary.net_issued, summary.unit)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <ActivityTable
          title="Recent settled activity"
          tickets={snapshot.recent_done.slice(0, 8)}
          now={snapshot.now}
        />
      </div>
    </div>
  )
}
