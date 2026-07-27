import { useState } from "react"

import { setUnitLifecycle, type ManagedUnit, type UnitLifecycle } from "@/lib/api"
import { runRestartingMutation } from "@/lib/restart"
import { useSnapshot } from "@/lib/snapshot"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

/**
 * Lifecycle transitions. Destructive moves confirm via AlertDialog where the
 * solid button is the safe cancel and the outline button commits the change.
 * The server enforces the guards (active tickets, unexpired keysets).
 */
export function LifecycleActions({ unit }: { unit: ManagedUnit }) {
  const { refresh } = useSnapshot()
  const [busy, setBusy] = useState(false)

  async function change(lifecycle: UnitLifecycle, label: string) {
    setBusy(true)
    try {
      await runRestartingMutation(label, () => setUnitLifecycle(unit.unit, lifecycle), refresh)
    } catch {
      // toast already shown by runRestartingMutation
    } finally {
      setBusy(false)
    }
  }

  const code = unit.unit.toUpperCase()

  if (unit.lifecycle === "active") {
    return (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm" loading={busy}>
            Stop issuing
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop issuing {code}?</AlertDialogTitle>
            <AlertDialogDescription>
              New deposits are disabled. Existing ecash stays redeemable until every keyset
              reaches its final expiry. You can resume issuing at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep issuing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void change("redemption_only", `Stopping ${code} issuance…`)}
            >
              Stop issuing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  if (unit.lifecycle === "redemption_only") {
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          loading={busy}
          onClick={() => void change("active", `Resuming ${code} issuance…`)}
        >
          Resume issuing
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" loading={busy}>
              Retire unit
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Retire {code}?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes the unit from all advertised operations. The server blocks retirement
                until every keyset has passed its final expiry, so outstanding ecash cannot be
                stranded. Retirement is permanent.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep redemptions</AlertDialogCancel>
              <AlertDialogAction onClick={() => void change("retired", `Retiring ${code}…`)}>
                Retire unit
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    )
  }

  return (
    <p className="m-0 text-sm text-muted-foreground">
      Retired. Historical keysets stay visible for protocol records.
    </p>
  )
}
