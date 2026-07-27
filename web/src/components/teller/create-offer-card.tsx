import { useEffect, useState, type FormEvent } from "react"

import { createQuote, type AppSnapshot } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Field } from "@/components/shared/bits"

export function CreateOfferCard({
  snapshot,
  onRefresh,
}: {
  snapshot: AppSnapshot
  onRefresh: () => Promise<void>
}) {
  const [deposit, setDeposit] = useState(true)
  const availableUnits = snapshot.units.filter((unit) =>
    deposit ? unit.can_mint : unit.can_melt,
  )
  const [unit, setUnit] = useState(availableUnits[0]?.unit ?? "")
  const [amount, setAmount] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!availableUnits.some((item) => item.unit === unit)) {
      setUnit(availableUnits[0]?.unit ?? "")
    }
  }, [availableUnits, unit])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createQuote({
        kind: deposit ? "mint" : "melt",
        unit,
        amount: Number(amount),
        description: description || undefined,
      })
      setAmount("")
      setDescription("")
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the offer.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New offer</CardTitle>
        <CardDescription>
          The customer's wallet scans the offer and claims it exactly once.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-5" onSubmit={submit}>
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1">
            <FlowButton active={deposit} onClick={() => setDeposit(true)}>
              Deposit
            </FlowButton>
            <FlowButton active={!deposit} onClick={() => setDeposit(false)}>
              Withdraw
            </FlowButton>
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
            <Field label="Amount" htmlFor="offer-amount">
              <Input
                id="offer-amount"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field label="Unit" htmlFor="offer-unit">
              <Select
                id="offer-unit"
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                required
              >
                {availableUnits.map((item) => (
                  <option key={item.unit} value={item.unit}>
                    {item.unit.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {availableUnits.length === 0 && (
            <Alert variant="emphasis">
              <AlertTitle>No unit supports this operation</AlertTitle>
              <AlertDescription>
                {deposit
                  ? "Every unit has issuing stopped. Resume issuing in the Console's Units tab."
                  : "Every unit is retired. Withdrawals need a unit that still allows redemptions."}
              </AlertDescription>
            </Alert>
          )}

          <Field label="Note (optional)" htmlFor="offer-note">
            <Input
              id="offer-note"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Receipt or customer reference"
            />
          </Field>

          {error && (
            <Alert variant="emphasis">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          )}

          <div className="grid gap-2">
            <Button type="submit" size="xl" loading={busy} disabled={busy || !unit}>
              Create offer
            </Button>
            <p className="m-0 text-center text-xs text-muted-foreground">
              One offer at a time. Offers expire after 15 minutes.
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function FlowButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-11 cursor-pointer rounded-md text-sm font-medium text-muted-foreground transition-colors",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "hover:bg-background hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}
