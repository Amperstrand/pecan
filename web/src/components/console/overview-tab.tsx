import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  PlusCircle,
  TriangleAlert,
  Wallet,
} from "lucide-react"

import type { AppSnapshot, CheckStatus, ChecklistItem } from "@/lib/api"
import { formatSignedAmount } from "@/lib/format"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ActivityTable } from "@/components/shared/activity-table"
import { CirculationChart } from "@/components/shared/circulation-chart"
import { StatTile } from "@/components/shared/stat-tile"

function statusIcon(status: CheckStatus | undefined) {
  switch (status) {
    case "ok":
      return <CircleCheck />
    case "warn":
      return <TriangleAlert />
    case "fail":
      return <CircleAlert />
    default:
      return <CircleDashed />
  }
}

export function OverviewTab({ snapshot }: { snapshot: AppSnapshot }) {
  const setup = snapshot.setup
  const byId = (id: string): ChecklistItem | undefined =>
    snapshot.checklist.find((check) => check.id === id)
  const reachable = byId("reachable")
  const linked = byId("linked")
  const worst: CheckStatus =
    (["fail", "warn", "unknown"] as CheckStatus[]).find((status) =>
      snapshot.checklist.some((check) => check.status === status),
    ) ?? "ok"

  return (
    <div className="grid gap-4">
      {!setup.setup_complete && (
        <Alert variant="emphasis">
          <PlusCircle />
          <AlertTitle>Not attached to a mint yet</AlertTitle>
          <AlertDescription>
            This processor serves one unit for a cdk mint you operate. Set the unit and mint URL
            in the{" "}
            <a className="underline underline-offset-2" href="#mint">
              Mint tab
            </a>
            , apply the config snippet to your mintd, and the checklist settles itself.
          </AlertDescription>
        </Alert>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile
          label="Mint"
          value={
            reachable?.status === "ok"
              ? "Online"
              : reachable?.status === "fail"
                ? "Offline"
                : "Not attached"
          }
          detail={
            snapshot.mint_identity?.name ??
            (setup.mint_url || "Set the mint URL in the Mint tab")
          }
          icon={statusIcon(reachable?.status)}
        />
        <StatTile
          label="Payment link"
          value={
            linked?.status === "ok"
              ? "Linked"
              : linked?.status === "warn"
                ? "Incomplete"
                : linked?.status === "fail"
                  ? "Waiting"
                  : "—"
          }
          detail={
            linked?.status === "ok"
              ? "The mint is attached to this processor"
              : "The mint has not attached to this processor yet"
          }
          icon={statusIcon(linked?.status)}
        />
        <StatTile
          label="Setup"
          value={
            worst === "ok"
              ? "Ready"
              : worst === "fail"
                ? "Needs attention"
                : worst === "warn"
                  ? "Check warnings"
                  : "Incomplete"
          }
          detail="Details in the Mint tab checklist"
          icon={statusIcon(worst)}
        />
        <StatTile
          label="Open quotes"
          value={String(snapshot.open_quotes.length)}
          detail="Wallet-created quotes awaiting the counter"
          icon={<CircleDot />}
        />
        <StatTile
          label="Net settled"
          value={setup.unit ? formatSignedAmount(snapshot.summary.net_issued, setup.unit) : "—"}
          detail={
            setup.unit
              ? "Settled deposits minus payouts at this counter"
              : "Set a unit to start"
          }
          icon={<Wallet />}
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
          <CirculationChart data={snapshot.circulation} unit={setup.unit} />
        </CardContent>
      </Card>

      <ActivityTable
        title="Recent settled activity"
        tickets={snapshot.recent_done.slice(0, 8)}
        now={snapshot.now}
      />
    </div>
  )
}
