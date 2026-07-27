import { TriangleAlert } from "lucide-react"

import type { AppSnapshot } from "@/lib/api"
import { formatExpiry } from "@/lib/format"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { KeysetBadge, LifecycleBadge } from "@/components/shared/badges"
import { DetailRow, EmptyState, MonoChip } from "@/components/shared/bits"
import { LifecycleActions } from "@/components/console/lifecycle-actions"
import { AddUnitDialog, EditPolicyDialog, RotateKeysetDialog } from "@/components/console/unit-dialogs"

export function UnitsTab({ snapshot }: { snapshot: AppSnapshot }) {
  const observed = snapshot.capabilities.filter(
    (pair) => !snapshot.units.some((unit) => unit.unit === pair.unit),
  )

  return (
    <div className="grid gap-4">
      {!snapshot.consistency.ok && (
        <Alert variant="emphasis">
          <TriangleAlert />
          <AlertTitle>Configuration is not yet consistent</AlertTitle>
          <AlertDescription>
            <ul className="m-0 list-disc pl-4">
              {snapshot.consistency.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {!snapshot.keysets.ok && (
        <Alert variant="emphasis">
          <TriangleAlert />
          <AlertTitle>Could not read keysets from the mint</AlertTitle>
          <AlertDescription>{snapshot.keysets.error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="m-0 text-sm text-muted-foreground">
          {snapshot.units.length} managed unit{snapshot.units.length === 1 ? "" : "s"} on the{" "}
          <span className="font-mono">{snapshot.mint.method}</span> method.
        </p>
        <AddUnitDialog snapshot={snapshot} />
      </div>

      {snapshot.units.map((unit) => {
        const keysets = snapshot.keysets.items.filter((keyset) => keyset.unit === unit.unit)
        return (
          <Card key={unit.unit}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 font-mono uppercase">
                {unit.unit}
                <LifecycleBadge lifecycle={unit.lifecycle} />
              </CardTitle>
              <CardDescription>
                {unit.can_mint ? "Deposits on" : "Deposits off"} ·{" "}
                {unit.can_melt ? "withdrawals on" : "withdrawals off"}
              </CardDescription>
              <CardAction>
                <EditPolicyDialog unit={unit} />
                <RotateKeysetDialog unit={unit} now={snapshot.now} />
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-5">
              <div className="grid gap-2.5">
                <DetailRow label="Keyset lifetime">
                  {unit.rollover.keyset_lifetime_days} days
                  {unit.rollover.enabled
                    ? ` · auto-rotates ${unit.rollover.rotate_before_expiry_days} days before expiry`
                    : " · automatic rotation off"}
                </DetailRow>
                <DetailRow label="Input fee">
                  <span className="font-mono">{unit.rollover.input_fee_ppk} ppk</span>
                </DetailRow>
                <DetailRow label="Denominations">
                  <span className="break-all font-mono text-xs">
                    {unit.rollover.amounts.join(", ")}
                  </span>
                </DetailRow>
              </div>

              {keysets.length === 0 ? (
                <EmptyState
                  title="No keysets yet"
                  body="The rollover worker creates the first keyset once the mint is reachable."
                />
              ) : (
                <Table className="min-w-[480px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Keyset</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Final expiry</TableHead>
                      <TableHead>Fee ppk</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {keysets.map((keyset) => (
                      <TableRow key={keyset.id}>
                        <TableCell>
                          <MonoChip>{keyset.id}</MonoChip>
                        </TableCell>
                        <TableCell>
                          <KeysetBadge keyset={keyset} now={snapshot.now} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatExpiry(keyset.final_expiry, snapshot.now)}
                        </TableCell>
                        <TableCell className="font-mono">{keyset.input_fee_ppk}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
            <CardFooter className="border-t pt-4">
              <LifecycleActions unit={unit} />
            </CardFooter>
          </Card>
        )
      })}

      {observed.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Observed units</CardTitle>
            <CardDescription>
              Advertised by the mint but outside the {snapshot.mint.method} teller workflow.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {observed.map((pair) => (
              <Badge key={`${pair.unit}:${pair.method}`} variant="muted">
                {pair.unit.toUpperCase()} · {pair.method}
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
