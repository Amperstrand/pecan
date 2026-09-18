import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

import {
  type FarmOverview,
  type FarmPurchaseInfo,
  type FarmSeriesInfo,
  type FutureBalance,
  createFarmPurchase,
  fetchFarmOverview,
  fetchFarmTermsBlob,
  futureBalances,
  getFarmPurchase,
  mintFuture,
  pollRedemption,
  receiveFutureToken,
  sendFuture,
  startRedemption,
} from "@/lib/coco/farm"
import { futureTagOfSecret } from "@/lib/coco/future-methods"
import { AnimatedQr } from "@/components/wallet/animated-qr"

type Phase =
  | { kind: "idle" }
  | { kind: "invoicing"; date: string; quantity: number }
  | { kind: "awaiting-payment"; purchase: FarmPurchaseInfo & { payment: { bolt11: string } } }
  | { kind: "minting"; purchase: FarmPurchaseInfo }
  | { kind: "owned"; unit: string; quantity: number }

function fmtDate(date: string): string {
  const [y, m, d] = date.split("-")
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  return dt.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })
}

function fmtMaturity(unix: number): string {
  return new Date(unix * 1000).toUTCString().replace(" GMT", " UTC")
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Sarah's farm tab: pick a production day, buy egg futures with real
 * signet sats, hold bearer claims, transfer ownership, redeem them at the
 * counter. The protocol details (NUT-32 unit, terms hash, mint) sit
 * behind the "details" expander.
 */
export function FarmPanel() {
  const [overview, setOverview] = useState<FarmOverview | null>(null)
  const [balances, setBalances] = useState<FutureBalance[] | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const [quantity, setQuantity] = useState("5")
  const [error, setError] = useState<string | null>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [termsCheck, setTermsCheck] = useState<string | null>(null)
  const [sendQty, setSendQty] = useState("2")
  const [tokenOut, setTokenOut] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [selectedUnit, setSelectedUnit] = useState<string>("")
  const [tokenIn, setTokenIn] = useState("")
  const [redeemQty, setRedeemQty] = useState("2")
  const [receipt, setReceipt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)
  const overviewRef = useRef<FarmOverview | null>(null)

  const refresh = useCallback(async () => {
    // The overview must never wait on the wallet: a slow/throwing
    // balances call (fresh boot, keyset sync) left the panel on
    // "loading series…" with the error swallowed.
    try {
      const o = await fetchFarmOverview()
      overviewRef.current = o
      setOverview(o)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
      return null
    }
    try {
      setBalances(await futureBalances())
    } catch {
      setBalances((b) => b)
    }
    return overviewRef.current
  }, [])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => void refresh(), 15_000)
    return () => window.clearInterval(t)
  }, [refresh])

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [])

  const nextSeries: FarmSeriesInfo | null = useMemo(() => {
    if (!overview) return null
    if (selectedDate) {
      return overview.series.find((s) => s.date === selectedDate) ?? null
    }
    // Sales stay open for the whole production day (UTC), so today's
    // eggs lead the picker even after the collection hour — same-day
    // purchase is the demo path.
    const today = new Date().toISOString().slice(0, 10)
    const sellable = overview.series.filter((s) => s.date >= today && s.available > 0)
    return sellable[0] ?? overview.series[0] ?? null
  }, [overview, selectedDate])

  const buy = useCallback(
    async (series: FarmSeriesInfo) => {
      const qty = Number(quantity)
      if (!Number.isInteger(qty) || qty < 1 || qty > series.available) {
        setError(`quantity must be 1..${series.available}`)
        return
      }
      setBusy(true)
      setError(null)
      setPhase({ kind: "invoicing", date: series.date, quantity: qty })
      try {
        const purchase = await createFarmPurchase(series.date, qty)
        setPhase({ kind: "awaiting-payment", purchase })
        pollRef.current = window.setInterval(async () => {
          const current = await getFarmPurchase(purchase.purchase_id).catch(() => null)
          if (!current) return
          if (current.state === "paid" || current.state === "authorized") {
            if (pollRef.current) window.clearInterval(pollRef.current)
            pollRef.current = null
            setPhase({ kind: "minting", purchase: current })
            try {
              await mintFuture(current)
              await refresh()
              setPhase({ kind: "owned", unit: current.unit, quantity: qty })
            } catch (e) {
              const message = `minting failed: ${e instanceof Error ? e.message : String(e)}`
              setError(message)
              setPhase({ kind: "idle" })
              console.error("[farm]", message)
            }
          } else if (current.state === "expired" || current.state === "failed") {
            if (pollRef.current) window.clearInterval(pollRef.current)
            pollRef.current = null
            setError(`purchase ${current.state}`)
            setPhase({ kind: "idle" })
          }
        }, 3000)
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e))
        setPhase({ kind: "idle" })
      } finally {
        setBusy(false)
      }
    },
    [quantity, refresh],
  )

  const verifyTerms = useCallback(async (series: FarmSeriesInfo) => {
    setTermsCheck("checking…")
    try {
      const blob = await fetchFarmTermsBlob(series.terms_sha256)
      const digest = await sha256Hex(blob)
      const envelope = JSON.parse(blob) as {
        mint: string
        signature: string
        terms: { unit: string }
      }
      const tagOk = digest === series.terms_sha256
      const unitOk = envelope.terms.unit === series.unit
      setTermsCheck(
        `${tagOk ? "✓" : "✗"} content address ${digest.slice(0, 12)}… · ` +
          `${unitOk ? "✓" : "✗"} terms.unit matches the series · mint ${envelope.mint}`,
      )
    } catch (e) {
      setTermsCheck(`verification failed: ${String(e)}`)
    }
  }, [])

  useEffect(() => {
    if (!selectedUnit && balances && balances.length > 0) setSelectedUnit(balances[0].unit)
    if (selectedUnit && balances && !balances.some((b) => b.unit === selectedUnit) && balances.length > 0) {
      setSelectedUnit(balances[0].unit)
    }
  }, [balances, selectedUnit])

  const doSend = useCallback(
    async (unit: string) => {
      const qty = Number(sendQty)
      if (!Number.isInteger(qty) || qty < 1) {
        setError("send quantity must be a positive integer")
        return
      }
      setBusy(true)
      setError(null)
      try {
        const result = await sendFuture(unit, qty)
        setTokenOut(result.token)
        await refresh()
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e))
      } finally {
        setBusy(false)
      }
    },
    [sendQty, refresh],
  )

  const doReceive = useCallback(async () => {
    if (!tokenIn.trim()) return
    setBusy(true)
    setError(null)
    try {
      await receiveFutureToken(tokenIn.trim())
      setTokenIn("")
      await refresh()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }, [tokenIn, refresh])

  const doRedeem = useCallback(
    async (unit: string) => {
      const qty = Number(redeemQty)
      if (!Number.isInteger(qty) || qty < 1) {
        setError("redeem quantity must be a positive integer")
        return
      }
      setBusy(true)
      setError(null)
      setReceipt(null)
      try {
        const start = await startRedemption(unit, qty)
        setReceipt(`waiting — teller code ${start.tail}`)
        const deadline = Date.now() + 10 * 60_000
        const t = window.setInterval(async () => {
          const result = await pollRedemption(start.quoteId).catch(() => null)
          if (result === "FAILED") {
            window.clearInterval(t)
            setReceipt("redemption failed — proofs restored")
            setBusy(false)
          } else if (result) {
            window.clearInterval(t)
            setReceipt(result)
            setBusy(false)
            await refresh()
          } else if (Date.now() > deadline) {
            window.clearInterval(t)
            setReceipt("still waiting for the operator to confirm handover")
            setBusy(false)
          }
        }, 2500)
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e))
        setBusy(false)
      }
    },
    [redeemQty, refresh],
  )

  const totalEggs = (balances ?? []).reduce((sum, b) => sum + b.amount, 0)

  return (
    <>
      <Card>
        <CardHeader>
          <CardDescription>YOU OWN</CardDescription>
          <CardTitle className="text-2xl">
            {balances === null ? "…" : `${totalEggs} egg claims`}
          </CardTitle>
        </CardHeader>
        {balances !== null && balances.length > 0 && (
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Egg series">
              {balances.map((b) => (
                <button
                  key={b.unit}
                  role="tab"
                  aria-selected={selectedUnit === b.unit}
                  onClick={() => setSelectedUnit(b.unit)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    selectedUnit === b.unit
                      ? "bg-primary text-primary-foreground border-primary"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {fmtDate(b.date ?? "")} · {b.amount} 🥚
                </button>
              ))}
            </div>
            {balances.filter((b) => b.unit === selectedUnit).map((b) => (
              <div key={b.unit} className="rounded-md border p-3 grid gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">
                    Farm — {fmtDate(b.date ?? "")} eggs · {b.amount}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-xs"
                    onClick={() => setDebugOpen(!debugOpen)}
                  >
                    {debugOpen ? "hide" : "details"}
                  </Button>
                </div>
                {debugOpen && (
                  <dl className="grid gap-1 text-xs text-muted-foreground font-mono">
                    <div>unit: {b.unit}</div>
                    <div className="break-all">terms: {b.termsUri ?? "(unknown)"}</div>
                  </dl>
                )}
                <div className="flex items-center gap-2 text-sm">
                  <Input
                    className="w-16 h-8"
                    value={sendQty}
                    onChange={(e) => setSendQty(e.target.value)}
                    aria-label={`send quantity for ${b.unit}`}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void doSend(b.unit)}
                  >
                    Transfer ownership
                  </Button>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Input
                    className="w-16 h-8"
                    value={redeemQty}
                    onChange={(e) => setRedeemQty(e.target.value)}
                    aria-label={`redeem quantity for ${b.unit}`}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void doRedeem(b.unit)}
                  >
                    Redeem at farm
                  </Button>
                </div>
                {receipt && (
                  <div className="rounded bg-muted p-2 text-xs font-mono break-all">{receipt}</div>
                )}
              </div>
            ))}
            {tokenOut && (
              <div className="grid gap-2 justify-items-center rounded-md border p-3" data-testid="transfer-out">
                <span className="text-xs text-muted-foreground">
                  Ownership transferred — {sendQty} egg{Number(sendQty) === 1 ? "" : "s"} now belong to whoever holds this code:
                </span>
                <AnimatedQr payload={tokenOut} />
                <textarea
                  readOnly
                  data-testid="farm-token"
                  className="rounded bg-muted p-2 text-xs font-mono break-all h-16 w-full"
                  value={tokenOut}
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void navigator.clipboard.writeText(tokenOut).then(() => setCopied(true))}
                  >
                    {copied ? "Copied ✓" : "Copy token"}
                  </Button>
                  <Button variant="outline" size="sm">
                    <a href="/redeem" target="_blank" rel="noreferrer">Open redeem kiosk ↗</a>
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardContent className="pt-6 grid gap-2">
          <TextareaLike value={tokenIn} onChange={setTokenIn} placeholder="paste a token to receive eggs" />
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void doReceive()}>
            Receive token
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">FARM</CardTitle>
          {nextSeries ? (
            <CardDescription>
              <select
                className="rounded-md border bg-background px-2 py-1 text-sm"
                value={nextSeries.date}
                aria-label="production day"
                onChange={(e) => setSelectedDate(e.target.value)}
              >
                {overview?.series.map((s) => (
                  <option key={s.date} value={s.date}>
                    {fmtDate(s.date)} · {s.available} of {s.capacity} free
                    {s.matured ? " · collectable now" : ""}
                  </option>
                ))}
              </select>
              {" "}· {nextSeries.price_sats} signet sats / egg
            </CardDescription>
          ) : (
            <CardDescription>loading series…</CardDescription>
          )}
        </CardHeader>
        <CardContent className="grid gap-3">
          {nextSeries && (
            <>
              <div className="flex items-end gap-2">
                <div className="grid gap-1">
                  <span className="text-xs text-muted-foreground">Quantity</span>
                  <Input
                    className="w-24"
                    inputMode="numeric"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    aria-label="egg quantity"
                  />
                </div>
                <div className="text-sm">
                  <div>
                    {quantity} egg{quantity === "1" ? "" : "s"}
                  </div>
                  <div className="font-semibold">
                    {nextSeries.price_sats * (Number(quantity) || 0)} signet sats
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Production: {fmtDate(nextSeries.date)}
                    <br />
                    Available for pickup: {fmtMaturity(nextSeries.maturity)}
                  </div>
                </div>
              </div>
              {phase.kind === "awaiting-payment" ? (
                <div className="grid gap-2 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    <span className="text-sm font-medium">
                      Pay {phase.purchase.total_sats} signet sats — waiting for payment
                    </span>
                  </div>
                  <textarea
                    readOnly
                    data-testid="farm-invoice"
                    className="rounded bg-muted p-2 text-xs font-mono break-all h-20"
                    value={phase.purchase.payment.bolt11}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void navigator.clipboard.writeText(phase.purchase.payment.bolt11)}
                  >
                    Copy invoice
                  </Button>
                </div>
              ) : phase.kind === "minting" ? (
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" />
                  Payment received — minting {phase.purchase.quantity} egg claims…
                </div>
              ) : phase.kind === "owned" ? (
                <div className="rounded-md border border-primary/40 p-3 text-sm">
                  YOU OWN — Farm eggs · {phase.quantity} claims of{" "}
                  <span className="font-mono text-xs">{phase.unit}</span>
                </div>
              ) : (
                <Button disabled={busy || nextSeries.available < 1} onClick={() => void buy(nextSeries)}>
                  {busy && phase.kind === "invoicing" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Creating purchase…
                    </>
                  ) : (
                    `Buy for ${nextSeries.price_sats * (Number(quantity) || 0)} signet sats`
                  )}
                </Button>
              )}
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => void verifyTerms(nextSeries)}
                >
                  verify terms
                </Button>
                {termsCheck && (
                  <div className="text-xs text-muted-foreground font-mono break-all">
                    {termsCheck}
                  </div>
                )}
              </div>
            </>
          )}
          {overview && overview.series.length > 1 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">all series ({overview.series.length})</summary>
              <ul className="mt-2 grid gap-1">
                {overview.series.map((s) => (
                  <li key={s.date} className="font-mono">
                    {s.date} · cap {s.capacity} · free {s.available} · redeemed {s.redeemed}
                    {s.actual_production !== null && s.actual_production < s.capacity
                      ? ` · ⚠ actual production ${s.actual_production} (issuer default on the rest)`
                      : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {error && (
            <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  )
}

function TextareaLike(props: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <textarea
      className="flex rounded-md border border-input bg-background px-3 py-2 text-xs font-mono break-all h-16"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
    />
  )
}

export { futureTagOfSecret }
