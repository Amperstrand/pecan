import { useSnapshot } from "@/lib/snapshot"
import { useNow } from "@/lib/use-now"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ActivityTable } from "@/components/shared/activity-table"
import { ActiveTicketCard } from "@/components/teller/active-ticket-card"
import { CreateOfferCard } from "@/components/teller/create-offer-card"

export function TellerPage() {
  const { snapshot, refresh } = useSnapshot()
  const now = useNow(snapshot.now)
  const active = snapshot.active_tickets

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-6">
      {active.length === 0 && <CreateOfferCard snapshot={snapshot} onRefresh={refresh} />}
      {active.length === 1 && (
        <ActiveTicketCard ticket={active[0]} now={now} onRefresh={refresh} />
      )}
      {active.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Multiple active quotes</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert variant="emphasis">
              <AlertTitle>The server reports more than one active quote.</AlertTitle>
              <AlertDescription>
                Resolve the extra ticket before continuing. This should not happen in normal
                operation.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      )}

      <ActivityTable
        title="Recent activity"
        tickets={snapshot.recent_done}
        now={snapshot.now}
        showNotes
      />
    </div>
  )
}
