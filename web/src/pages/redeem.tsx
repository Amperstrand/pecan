import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"

import {
  fetchFarmOverview,
  receiveFutureToken,
  type FarmOverview,
} from "@/lib/coco/farm"
import { runFarmRedemption } from "@/lib/coco/farm-redemption"
import { decodeQrFrames } from "@/components/wallet/animated-qr"
import { CameraScanner } from "@/components/teller/camera-scanner"
import { Button } from "@/components/ui/button"

// The claims portal (Egg Redemption Kiosk) — a phone-first page for
// people holding egg futures: scan the animated transfer QR (or paste
// the code), see the claim validated against its production date, and
// redeem with one tap. The scanned token is a bearer Cashu token:
// importing it here IS taking ownership, exactly like handing over the
// eggs. The redemption logic is the same runFarmRedemption flow the
// wallet's FARM tab uses — this page is its self-service face, the
// teller console its operator face.

type Phase =
  | { kind: "scanning" }
  | { kind: "importing" }
  | { kind: "verdict"; unit: string; qty: number; series: FarmOverview["series"][number] }
  | { kind: "redeeming"; tail: string }
  | { kind: "done"; receipt: string }
  | { kind: "error"; message: string }


export function RedeemPage() {
  const [phase, setPhase] = useState<Phase>({ kind: "scanning" })
  const [overview, setOverview] = useState<FarmOverview | null>(null)
  const [pasted, setPasted] = useState("")
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
    try {
      await runFarmRedemption(unit, qty, (update) => {
        if (update.kind === "waiting") setPhase({ kind: "redeeming", tail: update.tail })
        else if (update.kind === "receipt") setPhase({ kind: "done", receipt: update.receipt })
        else if (update.kind === "failed")
          setPhase({ kind: "error", message: "Redemption failed — your egg claims are restored." })
        else
          setPhase({
            kind: "error",
            message: "Still waiting for the farm to confirm handover — check back shortly.",
          })
      })
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
          <div className="kiosk-paste">
            <input
              data-testid="kiosk-token-input"
              className="kiosk-paste-input"
              placeholder="…or paste the egg transfer code"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pasted.trim()) void onFrame(pasted.trim())
              }}
            />
            <Button
              size="sm"
              disabled={!pasted.trim()}
              onClick={() => void onFrame(pasted.trim())}
            >
              Validate code
            </Button>
          </div>
        </section>
      )}

      {phase.kind === "importing" && (
        <section className="kiosk-card kiosk-center">
          <Loader2 className="kiosk-spin" />
          <p>Validating your claim…</p>
        </section>
      )}

      {phase.kind === "verdict" && (() => {
        const today = new Date().toISOString().slice(0, 10)
        const day = phase.series.date
        const claimable = day === today
        return (
          <section className={`kiosk-card kiosk-verdict ${claimable ? "ok" : "bad"}`}>
            <div className="kiosk-stamp" aria-hidden>🥚</div>
            <h2>{phase.qty} egg{phase.qty === 1 ? "" : "s"} — {day}</h2>
            {claimable ? (
              <>
                <p>Claim valid — collect 24/7 today; imaginary eggs are delivered best effort.</p>
                <Button size="lg" onClick={() => void doRedeem(phase.unit, phase.qty)}>
                  Redeem {phase.qty} egg{phase.qty === 1 ? "" : "s"}
                </Button>
              </>
            ) : day < today ? (
              <p className="kiosk-hint">
                The {day} collection day has ended — claim-it-or-lose-it: unclaimed eggs are lost.
              </p>
            ) : (
              <p className="kiosk-hint">
                These are {day}'s eggs — they become claimable 24/7 on {day} (claim-it-or-lose-it).
              </p>
            )}
          </section>
        )
      })()}

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
          <Button variant="outline" onClick={() => { frames.current.clear(); setPasted(""); setPhase({ kind: "scanning" }) }}>
            Scan another
          </Button>
        </section>
      )}

      {phase.kind === "error" && (
        <section className="kiosk-card kiosk-verdict bad kiosk-shake">
          <div className="kiosk-stamp" aria-hidden>✗</div>
          <h2>Not redeemable</h2>
          <p>{phase.message}</p>
          <Button variant="outline" onClick={() => { frames.current.clear(); setPasted(""); setPhase({ kind: "scanning" }) }}>
            Try again
          </Button>
        </section>
      )}
    </main>
  )
}
