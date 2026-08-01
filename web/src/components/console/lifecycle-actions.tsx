import { useState } from "react"

import { ApiRequestError, setUnitLifecycle, type ManagedUnit, type UnitLifecycle } from "@/lib/api"
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
 * The server enforces the guards: funded withdrawals block the change and
 * unexpired keysets block retirement; open unfunded wallet quotes for the
 * unit are voided automatically (anyone can create those, so they must not
 * be able to block console actions).
 */
export function LifecycleActions({ unit }: { unit: ManagedUnit }) {
  const { refresh } = useSnapshot()
  const [busy, setBusy] = useState(false)
  // Retirement against an unreachable EXTERNAL mint: the server refused the
  // keyset-expiry check; this arms a second, explicit "retire anyway" dialog.
  const [unreachableRetire, setUnreachableRetire] = useState(false)

  async function change(
    lifecycle: UnitLifecycle,
    label: string,
    options: { forceUnverified?: boolean } = {},
  ) {
    setBusy(true)
    try {
      await runRestartingMutation(
        label,
        () => setUnitLifecycle(unit.unit, lifecycle, options),
        refresh,
      )
      setUnreachableRetire(false)
    } catch (err) {
      // Toast already shown by runRestartingMutation; additionally arm the
      // escape hatch when the external mint could not be reached.
      if (
        lifecycle === "retired" &&
        err instanceof ApiRequestError &&
        err.message.startsWith("mint unreachable:")
      ) {
        setUnreachableRetire(true)
      }
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
              New deposits are disabled and any open {code} quotes are voided (funded
              withdrawals must be settled first). Existing ecash stays redeemable until every
              keyset reaches its final expiry. You can resume issuing at any time.
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
                Removes the unit from all advertised operations; any open {code} quotes are
                voided. The server blocks retirement until every keyset has passed its final
                expiry, so redeemable ecash cannot be stranded. Retirement is permanent.
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
        <AlertDialog open={unreachableRetire} onOpenChange={setUnreachableRetire}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Your mint is unreachable — retire {code} anyway?</AlertDialogTitle>
              <AlertDialogDescription>
                The keyset-expiry check needs your external mint, and it did not answer. If the
                mint is only briefly down, bring it back and retry — the check protects
                redeemable {code} ecash. Retire without the check only if that mint is gone for
                good.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Wait for the mint</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void change("retired", `Retiring ${code}…`, { forceUnverified: true })
                }
              >
                Retire without the check
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
