import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { addUnit, rotateKeyset, updateUnitPolicy, type AppSnapshot, type ManagedUnit } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { runRestartingMutation } from "@/lib/restart"
import { useSnapshot } from "@/lib/snapshot"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Field } from "@/components/shared/bits"

/** Rotate: fee and amounts are fixed by the unit policy; only expiry is chosen. */
export function RotateKeysetDialog({ unit, now }: { unit: ManagedUnit; now: number }) {
  const { refresh } = useSnapshot()
  const [open, setOpen] = useState(false)
  const [finalExpiry, setFinalExpiry] = useState("")
  const [busy, setBusy] = useState(false)

  const defaultExpiry = now + unit.rollover.keyset_lifetime_days * 86_400
  const expiry = finalExpiry.trim() || String(defaultExpiry)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await rotateKeyset({
        unit: unit.unit,
        amounts: unit.rollover.amounts.join(","),
        input_fee_ppk: unit.rollover.input_fee_ppk,
        final_expiry: expiry,
      })
      toast.success(`Rotated ${unit.unit.toUpperCase()} to a new keyset`)
      setOpen(false)
      setFinalExpiry("")
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rotate the keyset.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={unit.lifecycle !== "active"}>
          Rotate keyset
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Rotate {unit.unit.toUpperCase()} keyset</DialogTitle>
            <DialogDescription>
              The new keyset signs all new ecash. Previous keysets verify until their baked-in
              expiry passes. Fee ({unit.rollover.input_fee_ppk} ppk) and denominations come from
              the unit policy.
            </DialogDescription>
          </DialogHeader>
          <Field
            label="Final expiry · unix seconds"
            help={`Immutable once created. ${formatDateTime(Number(expiry) || defaultExpiry)}`}
            htmlFor="rotate-expiry"
          >
            <Input
              id="rotate-expiry"
              type="number"
              min={now + 1}
              value={finalExpiry}
              placeholder={String(defaultExpiry)}
              onChange={(event) => setFinalExpiry(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Rotate keyset
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Edit an existing unit's rollover policy (applies after an automatic restart). */
export function EditPolicyDialog({ unit }: { unit: ManagedUnit }) {
  const { refresh } = useSnapshot()
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(unit.rollover.enabled)
  const [lifetime, setLifetime] = useState(String(unit.rollover.keyset_lifetime_days))
  const [leadTime, setLeadTime] = useState(String(unit.rollover.rotate_before_expiry_days))
  const [fee, setFee] = useState(String(unit.rollover.input_fee_ppk))
  const [amounts, setAmounts] = useState(unit.rollover.amounts.join(","))
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await runRestartingMutation(
        `Updating ${unit.unit.toUpperCase()} policy…`,
        () =>
          updateUnitPolicy(unit.unit, {
            enabled,
            keyset_lifetime_days: Number(lifetime),
            rotate_before_expiry_days: Number(leadTime),
            input_fee_ppk: Number(fee),
            amounts,
          }),
        refresh,
      )
      setOpen(false)
    } catch {
      // toast already shown by runRestartingMutation
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Edit policy
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{unit.unit.toUpperCase()} keyset policy</DialogTitle>
            <DialogDescription>
              Future rotations use these values. Applying restarts the mint briefly; you stay
              signed in.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
            <div>
              <Label htmlFor="policy-enabled">Automatic rotation</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Rotate before the active keyset reaches final expiry.
              </p>
            </div>
            <Switch id="policy-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Keyset lifetime · days" htmlFor="policy-lifetime">
              <Input
                id="policy-lifetime"
                type="number"
                min="2"
                value={lifetime}
                onChange={(event) => setLifetime(event.target.value)}
                required
              />
            </Field>
            <Field label="Rotate before expiry · days" htmlFor="policy-lead">
              <Input
                id="policy-lead"
                type="number"
                min="1"
                value={leadTime}
                onChange={(event) => setLeadTime(event.target.value)}
                required
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Input fee · ppk" htmlFor="policy-fee">
              <Input
                id="policy-fee"
                type="number"
                min="0"
                value={fee}
                onChange={(event) => setFee(event.target.value)}
                required
              />
            </Field>
            <Field label="Denominations" htmlFor="policy-amounts">
              <Input
                id="policy-amounts"
                className="font-mono text-xs"
                value={amounts}
                onChange={(event) => setAmounts(event.target.value)}
                required
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Save policy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AddUnitDialog({ snapshot }: { snapshot: AppSnapshot }) {
  const { refresh } = useSnapshot()
  const [open, setOpen] = useState(false)
  const defaults = snapshot.units[0]?.rollover ?? snapshot.rollover
  const [unit, setUnit] = useState("")
  const [lifetime, setLifetime] = useState(String(defaults.keyset_lifetime_days))
  const [leadTime, setLeadTime] = useState(String(defaults.rotate_before_expiry_days))
  const [fee, setFee] = useState(String(defaults.input_fee_ppk))
  const [amounts, setAmounts] = useState(defaults.amounts.join(","))
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await runRestartingMutation(
        `Adding unit ${unit.toUpperCase()}…`,
        () =>
          addUnit({
            unit,
            keyset_lifetime_days: Number(lifetime),
            rotate_before_expiry_days: Number(leadTime),
            input_fee_ppk: Number(fee),
            amounts,
          }),
        refresh,
      )
      setOpen(false)
      setUnit("")
    } catch {
      // toast already shown by runRestartingMutation
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Add unit</Button>
      </DialogTrigger>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add a unit</DialogTitle>
            <DialogDescription>
              {snapshot.mint_connection.mode === "external"
                ? `Creates a signing keyset and advertises ${snapshot.mint.method} deposit and withdrawal support. Afterwards, apply the updated config snippet (Mint tab) to your mintd and restart it.`
                : snapshot.units.length === 0
                  ? `Creates a signing keyset, advertises ${snapshot.mint.method} deposit and withdrawal support, and starts the mint (it stays offline while no unit exists).`
                  : `Creates a signing keyset and advertises ${snapshot.mint.method} deposit and withdrawal support. Applying restarts the mint briefly.`}
            </DialogDescription>
          </DialogHeader>
          <Field label="Unit code" help="Lowercase; cannot be renamed later." htmlFor="add-unit-code">
            <Input
              id="add-unit-code"
              className="font-mono"
              value={unit}
              pattern="[a-z0-9_-]+"
              placeholder="usd"
              onChange={(event) => setUnit(event.target.value.toLowerCase())}
              required
              autoFocus
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Keyset lifetime · days" htmlFor="add-lifetime">
              <Input
                id="add-lifetime"
                type="number"
                min="2"
                value={lifetime}
                onChange={(event) => setLifetime(event.target.value)}
                required
              />
            </Field>
            <Field label="Rotate before expiry · days" htmlFor="add-lead">
              <Input
                id="add-lead"
                type="number"
                min="1"
                value={leadTime}
                onChange={(event) => setLeadTime(event.target.value)}
                required
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Input fee · ppk" htmlFor="add-fee">
              <Input
                id="add-fee"
                type="number"
                min="0"
                value={fee}
                onChange={(event) => setFee(event.target.value)}
                required
              />
            </Field>
            <Field label="Denominations" htmlFor="add-amounts">
              <Input
                id="add-amounts"
                className="font-mono text-xs"
                value={amounts}
                onChange={(event) => setAmounts(event.target.value)}
                required
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Add unit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
