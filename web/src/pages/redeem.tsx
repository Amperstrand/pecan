import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2 } from "lucide-react"

import {
  fetchFarmOverview,
  receiveFutureToken,
  startRedemption,
  pollRedemption,
  type FarmOverview,
} from "@/lib/coco/farm"
import { decodeQrFrames } from "@/components/wallet/animated-qr"
import { CameraScanner } from "@/components/teller/camera-scanner"
import { Button } from "@/components/ui/button"

// The Egg Redemption Kiosk — a phone-first page for people holding egg
// futures: scan the animated transfer QR, see the claim validated (or a
// countdown to delivery), and redeem with one tap. The scanned token is
// a bearer Cashu token: importing it here IS taking ownership, exactly
// like handing over the eggs.
//
// Served at /{pair}-console/redeem (works for any pair hosting the farm
// rail; the farm mint is the same regardless).

type Phase =
  | { kind: "scanning" }
  | { kind: "importing" }
  | { kind: "verdict"; unit: string; qty: number; series: FarmOverview["series"][number] }
  | { kind: "redeeming"; tail: string; quoteId: string }
  | { kind: "done"; receipt: string }
  | { kind: "error"; message: string }

function fmtWhen(unix: number): string {
  const d = new Date(unix * 1000)
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function timeLeft(unix: number): string {
  const s = Math.max(0, unix - Date.now() / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function RedeemPage() {
  const [phase, setPhase] = useState<Phase>({ kind: "scanning" })
  const [overview, setOverview] = useState<FarmOverview | null>(null)
  const frames = useRef<Set<string>>(new Set())

  useEffect(() => {
    void fetchFarmOverview().then(setOverview).catch(() => undefined)
  }, [])

  const onFrame = useCallback(async (payload: string) => {
    if (payload.startsWith("FARMQR ")) {
      frames.current.add(payload)
      const seen = [...frames.current]
      const total = Number(payload.match(/^FARMQR \d+\/(\d+):/)?.[1] ?? 0)
      if (seen.length < total) return
      const token = decodeQrFrames(seen)
      if (!token) return
      frames.current.clear()
      await importToken(token)
      return
    }
    if (payload.length > 80) await importToken(payload)
  }, [])

  const importToken = useCallback(async (token: string) => {
    setPhase({ kind: "importing" })
    try {
      const qty = await receiveFutureToken(token)
      const ov = overview ?? (await fetchFarmOverview().catch(() => null))
      // receiveFutureToken returns total received; resolve the unit from
      // the newest future balance.
      const { futureBalances } = await import("@/lib/coco/farm")
      const balances = await futureBalances()
      const target = balances.find(b => b.amount >= qty) ?? balances[balances.length - 1]
      if (!target || !ov) {
        setPhase({ kind: "error", message: "Token imported, but the farm could not be reached to validate it. Try again." })
        return
      }
      const series = ov.series.find(s => s.unit === target.unit)
      if (!series) {
        setPhase({ kind: "error", message: `Unknown series ${target.unit}` })
        return
      }
      setPhase({ kind: "verdict", unit: target.unit, qty, series })
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }, [overview])

  const doRedeem = useCallback(async (unit: string, qty: number) => {
    setPhase(p => (p.kind === "verdict" ? { ...p } : p))
    try {
      const start = await startRedemption(unit, qty)
      setPhase({ kind: "redeeming", tail: start.tail, quoteId: start.quoteId })
      const deadline = Date.now() + 10 * 60_000
      const t = window.setInterval(async () => {
        const result = await pollRedemption(start.quoteId).catch(() => null)
        if (result === "FAILED") {
          window.clearInterval(t)
          setPhase({ kind: "error", message: "Redemption failed — your egg claims are restored." })
        } else if (result) {
          window.clearInterval(t)
          setPhase({ kind: "done", receipt: result })
        } else if (Date.now() > deadline) {
          window.clearInterval(t)
          setPhase({ kind: "error", message: "Still waiting for the farm to confirm handover — check back shortly." })
        }
      }, 2500)
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  return (
    <main className="kiosk-root">
      <div className="kiosk-hero">
        <div className="kiosk-egg" aria-hidden>🥚</div>
        <h1>Egg Redemption Kiosk</h1>
        <p>Scan your egg transfer code — the kiosk validates it and redeems it at the counter.</p>
      </div>

      {phase.kind === "scanning" && (
        <section className="kiosk-card kiosk-scan">
          <div className="kiosk-pulse" aria-hidden />
          <CameraScanner onCode={onFrame} onCancel={() => undefined} />
          <p className="kiosk-hint">Hold the animated QR steady — it takes a few frames.</p>
        </section>
      )}

      {phase.kind === "importing" && (
        <section className="kiosk-card kiosk-center">
          <Loader2 className="kiosk-spin" />
          <p>Validating your claim…</p>
        </section>
      )}

      {phase.kind === "verdict" && (
        <section className={`kiosk-card kiosk-verdict ${phase.series.matured ? "ok" : "wait"}`}>
          <div className="kiosk-stamp" aria-hidden>{phase.series.matured ? "✓" : "🥚"}</div>
          <h2>{phase.qty} egg{phase.qty === 1 ? "" : "s"} — {phase.series.date}</h2>
          <p>Claim valid — redeem at the counter whenever the farm has eggs.</p>
          {!phase.series.matured && (
            <p className="kiosk-hint" data-testid="kiosk-countdown">
              Terms: collection opens {fmtWhen(phase.series.maturity)} ({timeLeft(phase.series.maturity)} to go) —
              this kiosk does not enforce the window.
            </p>
          )}
          <Button size="lg" onClick={() => void doRedeem(phase.unit, phase.qty)}>
            Redeem {phase.qty} egg{phase.qty === 1 ? "" : "s"}
          </Button>
        </section>
      )}

      {phase.kind === "redeeming" && (
        <section className="kiosk-card kiosk-center">
          <Loader2 className="kiosk-spin" />
          <p>Hand this code to the farm counter:</p>
          <div className="kiosk-tail" data-testid="kiosk-tail">{phase.tail}</div>
          <p className="kiosk-hint">Confirming handover…</p>
        </section>
      )}

      {phase.kind === "done" && (
        <section className="kiosk-card kiosk-verdict ok">
          <div className="kiosk-stamp" aria-hidden>✓</div>
          <h2>Eggs redeemed</h2>
          <p className="kiosk-receipt">{phase.receipt}</p>
          <Button variant="outline" onClick={() => { frames.current.clear(); setPhase({ kind: "scanning" }) }}>
            Scan another
          </Button>
        </section>
      )}

      {phase.kind === "error" && (
        <section className="kiosk-card kiosk-verdict bad kiosk-shake">
          <div className="kiosk-stamp" aria-hidden>✗</div>
          <h2>Not redeemable</h2>
          <p>{phase.message}</p>
          <Button variant="outline" onClick={() => { frames.current.clear(); setPhase({ kind: "scanning" }) }}>
            Try again
          </Button>
        </section>
      )}
    </main>
  )
}
