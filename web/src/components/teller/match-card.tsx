import { useState } from "react"
import { ScanLine } from "lucide-react"
import { toast } from "sonner"

import { matchQuote, type Ticket } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

/**
 * The till's first element: resolve the customer's quote. The code must come
 * off the customer's wallet screen — typed (last 6+ characters of the quote
 * id) or scanned (handheld scanners type the full id and press Enter, so a
 * plain form submit covers them).
 */
export function MatchCard({
  onMatched,
}: {
  onMatched: (ticket: Ticket, code: string) => void
}) {
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(event?: React.FormEvent) {
    event?.preventDefault()
    const entered = code.trim()
    if (!entered || busy) return
    setBusy(true)
    try {
      const ticket = await matchQuote(entered)
      setCode("")
      onMatched(ticket, entered)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not match the quote.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Match a quote</CardTitle>
        <CardDescription>
          Ask the customer for their quote code — scan it, or type the last 6+ characters
          shown in their wallet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-3">
          <Input
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Quote code — e.g. 9EC0F4"
            autoComplete="off"
            spellCheck={false}
            className="h-14 font-mono text-2xl tracking-[0.2em] uppercase placeholder:tracking-normal placeholder:normal-case md:text-2xl"
          />
          <Button type="submit" size="xl" loading={busy} disabled={!code.trim() || busy}>
            <ScanLine />
            Match quote
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
