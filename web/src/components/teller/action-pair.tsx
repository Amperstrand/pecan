import { Button } from "@/components/ui/button"

/**
 * The teller's action row: at most two big buttons. The interrupt (outline)
 * sits left, the affirm/proceed (solid) right. States that cannot proceed yet
 * render only the interrupt, full width. No confirmation checkboxes, ever —
 * the affirm button itself is the confirmation.
 */
export function ActionPair({
  interruptLabel,
  onInterrupt,
  proceedLabel,
  onProceed,
  busy,
}: {
  interruptLabel: string
  onInterrupt: () => void
  proceedLabel?: string
  onProceed?: () => void
  busy: "proceed" | "interrupt" | null
}) {
  if (!proceedLabel || !onProceed) {
    return (
      <Button
        variant="outline"
        size="xl"
        className="w-full"
        loading={busy === "interrupt"}
        disabled={busy !== null}
        onClick={onInterrupt}
      >
        {interruptLabel}
      </Button>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
      <Button
        variant="outline"
        size="xl"
        loading={busy === "interrupt"}
        disabled={busy !== null}
        onClick={onInterrupt}
      >
        {interruptLabel}
      </Button>
      <Button
        size="xl"
        loading={busy === "proceed"}
        disabled={busy !== null}
        onClick={onProceed}
      >
        {proceedLabel}
      </Button>
    </div>
  )
}
