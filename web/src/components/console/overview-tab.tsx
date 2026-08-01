import { CircleAlert, CircleCheck, CircleDashed, CircleDot, PlusCircle, Wallet } from "lucide-react"

import type { AppSnapshot, HealthItem } from "@/lib/api"
import { formatAmount, formatSignedAmount } from "@/lib/format"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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

  const supplyFor = (unit: string) =>
    snapshot.supply.available
      ? snapshot.supply.units.find((entry) => entry.unit === unit)
      : undefined
  const primarySupply = snapshot.mint.unit ? supplyFor(snapshot.mint.unit) : undefined

  return (
    <div className="grid gap-4">
      {snapshot.mint_connection.mode === "unset" ? (
        <Alert variant="emphasis">
          <PlusCircle />
          <AlertTitle>No mint connected yet</AlertTitle>
          <AlertDescription>
            This installation runs the processor only. Choose a mint in the Mint tab — use the
            bundled one, or connect a cdk-mintd you already operate.
          </AlertDescription>
        </Alert>
      ) : (
        snapshot.units.length === 0 && (
          <Alert variant="emphasis">
            <PlusCircle />
            <AlertTitle>No units configured yet</AlertTitle>
            <AlertDescription>
              {snapshot.mint_connection.mode === "external"
                ? "Nothing is advertised until a unit exists. Add the first unit in the Units tab, then apply the updated config snippet (Mint tab) to your mintd."
                : "The mint stays offline until it has a unit to serve — cdk requires at least one payment backend to start. Add the first unit in the Units tab; the mint starts automatically."}
            </AlertDescription>
          </Alert>
        )
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {health.map(([label, item]) => (
          <StatTile
            key={label}
            label={label}
            value={item.label}
            detail={item.detail}
            icon={
              item.ok ? <CircleCheck /> : item.label === "Standby" ? <CircleDashed /> : <CircleAlert />
            }
          />
        ))}
        <StatTile
          label={
            snapshot.mint.unit
              ? `Circulation · ${snapshot.mint.unit.toUpperCase()}`
              : "Circulation"
          }
          value={
            !snapshot.mint.unit
              ? "—"
              : primarySupply
                ? formatAmount(primarySupply.live, snapshot.mint.unit)
                : formatSignedAmount(snapshot.summary.net_issued, snapshot.mint.unit)
          }
          detail={
            !snapshot.mint.unit
              ? "Add a unit to start issuing"
              : primarySupply
                ? primarySupply.demonetized > 0
                  ? `Redeemable, audited from the mint — plus ${formatAmount(primarySupply.demonetized, snapshot.mint.unit)} demonetized by expired keysets`
                  : "Redeemable ecash, audited from the mint database"
                : "Net settled at the teller (supply audit unavailable)"
          }
          icon={<Wallet />}
        />
        <StatTile
          label="Open quotes"
          value={String(snapshot.open_quotes.length)}
          detail="Wallet-created quotes awaiting the counter"
          icon={<CircleDot />}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Settled activity</CardTitle>
          <CardDescription>
            Teller ledger over time: net of settled deposits and payouts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CirculationChart data={snapshot.circulation} unit={snapshot.mint.unit} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Unit balances</CardTitle>
            <CardDescription>
              Live supply is audited from the mint database; values from unlike units are
              never summed.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table className="min-w-[520px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Unit</TableHead>
                  <TableHead>Lifecycle</TableHead>
                  <TableHead>Live supply</TableHead>
                  <TableHead>Demonetized</TableHead>
                  <TableHead className="pr-6">Net settled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.unit_summaries.map((summary) => {
                  const managed = snapshot.units.find((unit) => unit.unit === summary.unit)
                  const supply = supplyFor(summary.unit)
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
                      <TableCell className="font-mono">
                        {supply ? formatAmount(supply.live, summary.unit) : "—"}
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground">
                        {supply
                          ? supply.demonetized > 0
                            ? formatAmount(supply.demonetized, summary.unit)
                            : "0"
                          : "—"}
                      </TableCell>
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
