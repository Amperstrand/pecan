import { useState } from "react"
import { Camera, ScanLine } from "lucide-react"
import { toast } from "sonner"

import { matchQuote, type Ticket } from "@/lib/api"
import { CameraScanner } from "@/components/teller/camera-scanner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

/**
 * The till's first element: resolve the customer's quote. The code must come
 * off the customer's wallet screen — typed (last 6+ characters of the quote
 * id), scanned by handheld scanners (they type the full id and press Enter,
 * so a plain form submit covers them), or scanned with this machine's
 * camera (the wallet renders the quote id as a QR).
 */
export function MatchCard({
  onMatched,
}: {
  onMatched: (ticket: Ticket, code: string) => void
}) {
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)

  async function submit(event?: React.FormEvent, scanned?: string) {
    event?.preventDefault()
    const entered = (scanned ?? code).trim()
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
        {scanning ? (
          <CameraScanner
            onCode={(payload) => {
              setScanning(false)
              void submit(undefined, payload)
            }}
            onCancel={() => setScanning(false)}
          />
        ) : (
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[auto_1fr]">
              <Button type="button" variant="outline" onClick={() => setScanning(true)}>
                <Camera />
                Scan with camera
              </Button>
              <Button
                type="submit"
                size="xl"
                loading={busy}
                disabled={!code.trim() || busy}
              >
                <ScanLine />
                Match quote
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
