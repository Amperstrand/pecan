import { useCallback, useEffect, useRef, useState } from "react"
import QRCode from "qrcode"
import { ArrowDown, ArrowUp, Loader2, Wallet as WalletIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

import {
  type DepositQuote,
  type DepositMethod,
  type HistoryRow,
  createDepositQuote,
  createWithdraw,
  getBalanceOre,
  getHistory,
  getPendingDeposit,
  getPendingWithdraw,
  pollAndMint,
  pollWithdraw,
  resumePendingOperations,
} from "@/lib/coco/coco-wallet"
import { getCoco } from "@/lib/coco/coco-wallet"

type DepositState =
  | { phase: "idle" }
  | { phase: "creating" }
  | { phase: "pending"; quote: DepositQuote }
  | { phase: "done"; receipt?: DepositReceipt }
  | { phase: "error"; message: string }

interface DepositReceipt {
  method: DepositMethod
  amountOre: number
  sat?: number
  address?: string
}

type WithdrawState =
  | { phase: "idle" }
  | { phase: "creating" }
  | { phase: "pending"; quoteId: string; tail: string }
  | { phase: "done"; preimage: string }
  | { phase: "error"; message: string }

function QrCodeImg({ text, alt }: { text: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: 220 })
      .then(setSrc)
      .catch(() => setSrc(null))
  }, [text])
  if (!src) return null
  // White pad behind the QR: scanners struggle with dark-mode backgrounds.
  return (
    <img src={src} alt={alt} width={220} height={220} className="rounded-md bg-white p-2" />
  )
}

function OnchainStatus({ address }: { address: string }) {
  const [status, setStatus] = useState<{
    receivedSat: number
    confirmations: number
    confirmed: boolean
    required: number
    explorer: string
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(`/api/onchain-status/${address}`)
        if (!res.ok) return
        const data: {
          tip: number
          utxos: Array<{
            value: number
            status: { confirmed: boolean; block_height?: number }
          }>
          required_confirmations: number
          explorer: string
        } = await res.json()
        if (cancelled || data.utxos.length === 0) return
        const receivedSat = data.utxos.reduce((s, u) => s + u.value, 0)
        const confirmed = data.utxos.some((u) => u.status.confirmed)
        const maxBlock = Math.max(
          ...data.utxos.map((u) => u.status.block_height ?? 0),
        )
        const confirmations = confirmed && data.tip > 0 && maxBlock > 0
          ? data.tip - maxBlock + 1
          : 0
        setStatus({
          receivedSat,
          confirmations,
          confirmed,
          required: data.required_confirmations,
          explorer: data.explorer,
        })
      } catch {
        // processor unreachable; the mint's own poller still settles
      }
    }
    void poll()
    const id = setInterval(poll, 10_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [address])

  if (!status) {
    return (
      <div className="grid gap-1.5 rounded-md bg-muted p-3 text-center">
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Waiting for transaction…
        </div>
        <p className="text-[10px] text-muted-foreground">
          Safe to close this page — your deposit will be credited automatically
        </p>
      </div>
    )
  }

  const required = status.required
  const enough = status.confirmations >= required
  const steps = ["Detected", `${required} conf`, "Credited"]
  const currentStep = !status.confirmed ? 0 : enough ? 2 : 1

  return (
    <div className="grid gap-2 rounded-md bg-muted p-3">
      {/* Progress steps */}
      <div className="flex items-center justify-between">
        {steps.map((label, i) => (
          <div key={label} className="flex items-center">
            <div
              className={`flex size-5 items-center justify-center rounded-full text-[9px] font-bold transition-colors ${
                i < currentStep
                  ? "bg-green-600 text-white"
                  : i === currentStep
                    ? status.confirmed && enough
                      ? "bg-green-600 text-white"
                      : "bg-amber-500 text-white"
                    : "bg-muted-foreground/20 text-muted-foreground"
              }`}
            >
              {i < currentStep || (i === currentStep && enough) ? "✓" : i + 1}
            </div>
            {i < steps.length - 1 && (
              <div
                className={`mx-1 h-px w-6 transition-colors sm:w-10 ${
                  i < currentStep ? "bg-green-600" : "bg-muted-foreground/20"
                }`}
              />
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between text-[10px]">
        {steps.map((label, i) => (
          <span
            key={label}
            className={
              i === currentStep
                ? "font-medium text-foreground"
                : "text-muted-foreground"
            }
          >
            {label}
          </span>
        ))}
      </div>

      {/* Detail line */}
      <div className="text-center text-xs">
        {!status.confirmed ? (
          <>
            <span className="font-medium text-amber-600 dark:text-amber-400">
              Payment detected in mempool
            </span>
            <span className="text-muted-foreground">
              {" "}· 0 of {required} confirmation{required === 1 ? "" : "s"}
            </span>
          </>
        ) : enough ? (
          <span className="font-medium text-green-600 dark:text-green-400">
            Confirmed — crediting your wallet…
          </span>
        ) : (
          <span className="font-medium text-amber-600 dark:text-amber-400">
            {status.confirmations} of {required} confirmation
            {required === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="text-center text-[10px] text-muted-foreground">
        {status.receivedSat.toLocaleString()} sat received · Bitcoin Signet
        (test network)
      </div>

      {/* Over/under payment warnings */}
      {status.receivedSat > 0 && (
        <div className="text-center text-[10px]">
          {status.confirmations >= required && status.receivedSat > 0 && (
            <span className="text-muted-foreground">
              Any sats above the quoted amount are kept as network fee
            </span>
          )}
        </div>
      )}

      {/* Explorer link */}
      {status.explorer && (
        <a
          href={`${status.explorer}/address/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-center text-[10px] underline text-muted-foreground hover:text-foreground"
        >
          View on block explorer ↗
        </a>
      )}
    </div>
  )
}

export function WalletPage() {
  const [balance, setBalance] = useState<number | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [depositAmount, setDepositAmount] = useState("")
  const [depositMethod, setDepositMethod] = useState<"branch" | "ln" | "btc">("branch")
  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [withdrawRecipient, setWithdrawRecipient] = useState("")
  const [depositState, setDepositState] = useState<DepositState>({ phase: "idle" })
  const [withdrawState, setWithdrawState] = useState<WithdrawState>({ phase: "idle" })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [ore, hist] = await Promise.all([getBalanceOre(), getHistory(15)])
      setBalance(ore)
      setHistory(hist)
    } catch {
      // wallet not initialized yet
    }
  }, [])

  useEffect(() => {
    let withdrawPollRef: ReturnType<typeof setInterval> | null = null

    getCoco()
      .then(async () => {
        refresh()

        // Restore any in-flight deposit/withdraw cards so a page reload
        // doesn't lose visual context (the operations complete either way,
        // but the user shouldn't see a blank form).
        const pendingDeposit = await getPendingDeposit()
        if (pendingDeposit) {
          setDepositState({ phase: "pending", quote: pendingDeposit })
          pollRef.current = setInterval(async () => {
            const done = await pollAndMint(pendingDeposit.quoteId)
            if (done) {
              if (pollRef.current) clearInterval(pollRef.current)
              pollRef.current = null
              setDepositState({
                phase: "done",
                receipt: {
                  method: pendingDeposit.method,
                  amountOre: pendingDeposit.amountOre,
                  sat: pendingDeposit.expectedSat,
                  address: pendingDeposit.method === "btc" ? pendingDeposit.request : undefined,
                },
              })
              refresh()
            }
          }, 3000)
        }

        const pendingWithdraw = await getPendingWithdraw()
        if (pendingWithdraw) {
          setWithdrawState({
            phase: "pending",
            quoteId: pendingWithdraw.quoteId,
            tail: pendingWithdraw.tail,
          })
          withdrawPollRef = setInterval(async () => {
            const preimage = await pollWithdraw(pendingWithdraw.quoteId)
            if (preimage) {
              if (withdrawPollRef) clearInterval(withdrawPollRef)
              withdrawPollRef = null
              setWithdrawState({ phase: "done", preimage })
              refresh()
              setTimeout(() => setWithdrawState({ phase: "idle" }), 5000)
            }
          }, 3000)
        }

        return resumePendingOperations(() => void refresh())
      })
      .catch(() => {})
      .finally(() => refresh())

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      if (withdrawPollRef) clearInterval(withdrawPollRef)
    }
  }, [refresh])

  const cancelDeposit = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    setDepositState({ phase: "idle" })
  }

  const startDeposit = async () => {
    const amount = parseFloat(depositAmount)
    if (!amount || amount < 1 || amount > 1000) return
    setDepositState({ phase: "creating" })
    try {
      const quote = await createDepositQuote(amount, depositMethod)
      setDepositState({ phase: "pending", quote })

      pollRef.current = setInterval(async () => {
        const done = await pollAndMint(quote.quoteId)
        if (done) {
          clearInterval(pollRef.current!)
          pollRef.current = null
          setDepositState({ phase: "done" })
          refresh()
          setTimeout(() => setDepositState({ phase: "idle" }), 3000)
        }
      }, 3000)
    } catch (e) {
      console.error("deposit failed:", e)
      setDepositState({ phase: "error", message: String(e) })
    }
  }

  const startWithdraw = async () => {
    const amount = parseFloat(withdrawAmount)
    if (!amount || amount < 1) return
    if (!withdrawRecipient.trim()) return
    setWithdrawState({ phase: "creating" })
    try {
      const result = await createWithdraw(amount, withdrawRecipient.trim())
      setWithdrawState({ phase: "pending", quoteId: result.quoteId, tail: result.tail })
      refresh()

      const interval = setInterval(async () => {
        const preimage = await pollWithdraw(result.quoteId)
        if (preimage) {
          clearInterval(interval)
          setWithdrawState({ phase: "done", preimage })
          refresh()
          setTimeout(() => setWithdrawState({ phase: "idle" }), 5000)
        }
      }, 3000)

      return () => clearInterval(interval)
    } catch (e) {
      console.error("withdraw failed:", e)
      setWithdrawState({ phase: "error", message: String(e) })
    }
  }

  const balanceKr = balance !== null ? (balance / 100).toFixed(2) : "…"
  const isDark = document.documentElement.classList.contains("dark")

  return (
    <main className="mx-auto grid min-h-screen max-w-lg gap-4 px-4 py-8">
      <div className="flex items-center gap-2">
        <WalletIcon className="size-5" />
        <h1 className="text-lg font-semibold">Wallet</h1>
        <span className="ml-auto text-xs text-muted-foreground">
          {window.location.hostname}
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardDescription>Balance</CardDescription>
          <CardTitle className="text-4xl tabular-nums">
            {balanceKr} <span className="text-base font-normal text-muted-foreground">kr</span>
          </CardTitle>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowDown className="size-4" /> Deposit
          </CardTitle>
          <CardDescription>
            Mint ecash at the counter (teller) or over lightning.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {depositState.phase === "done" && depositState.receipt ? (
            <div className="grid gap-3 rounded-lg border border-green-200 bg-green-50 p-4 text-center dark:border-green-900 dark:bg-green-950">
              <div className="text-2xl">✓</div>
              <p className="font-medium text-green-700 dark:text-green-300">
                Deposit confirmed
              </p>
              <p className="text-lg font-bold">
                +{(depositState.receipt.amountOre / 100).toFixed(2)} kr
              </p>
              <div className="text-xs text-muted-foreground">
                {depositState.receipt.method === "btc" && depositState.receipt.sat && (
                  <p>{depositState.receipt.sat.toLocaleString()} sat on-chain</p>
                )}
                {depositState.receipt.method === "ln" && <p>Lightning payment</p>}
                {depositState.receipt.method === "branch" && <p>Teller settlement</p>}
              </div>
              {depositState.receipt.method === "btc" && depositState.receipt.address && (
                <a
                  href={`https://mempool.space/signet/address/${depositState.receipt.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] underline text-muted-foreground hover:text-foreground"
                >
                  View on block explorer ↗
                </a>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDepositState({ phase: "idle" })}
              >
                New deposit
              </Button>
            </div>
          ) : depositState.phase === "idle" || depositState.phase === "done" ? (
            <>
              <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-muted p-1 text-sm">
                <button
                  type="button"
                  onClick={() => setDepositMethod("branch")}
                  className={`rounded-md px-3 py-1.5 transition-colors ${depositMethod === "branch" ? "bg-background font-medium shadow-sm" : "text-muted-foreground"}`}
                >
                  Teller
                </button>
                <button
                  type="button"
                  onClick={() => setDepositMethod("ln")}
                  className={`rounded-md px-3 py-1.5 transition-colors ${depositMethod === "ln" ? "bg-background font-medium shadow-sm" : "text-muted-foreground"}`}
                >
                  Lightning
                </button>
                <button
                  type="button"
                  onClick={() => setDepositMethod("btc")}
                  className={`rounded-md px-3 py-1.5 transition-colors ${depositMethod === "btc" ? "bg-background font-medium shadow-sm" : "text-muted-foreground"}`}
                >
                  On-chain
                </button>
              </div>
              {depositMethod === "btc" && (
                <p className="text-xs text-muted-foreground">
                  Minimum 50 kr — on-chain deposits pay for dust and chain fees.
                </p>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="dep-amt">Amount (kr)</Label>
                <Input
                  id="dep-amt"
                  type="number"
                  min="1"
                  max="1000"
                  step="0.01"
                  placeholder="5.00"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                />
              </div>
              <Button onClick={startDeposit} disabled={!depositAmount}>
                {depositState.phase === "done"
                  ? "✓ Deposited"
                  : depositMethod === "ln"
                    ? "Create lightning invoice"
                    : depositMethod === "btc"
                      ? "Create on-chain address"
                      : "Create deposit quote"}
              </Button>
            </>
          ) : depositState.phase === "creating" ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Creating quote…
            </div>
          ) : depositState.phase === "pending" ? (
            depositState.quote.method === "ln" ? (
              <div className="grid gap-3 text-center">
                <p className="text-sm text-muted-foreground">
                  Pay this lightning invoice (signet):
                </p>
                <div className="flex justify-center">
                  <QrCodeImg text={depositState.quote.request} alt="Lightning invoice QR" />
                </div>
                <p className="max-h-24 overflow-y-auto break-all rounded-md bg-muted p-2 font-mono text-xs select-all">
                  {depositState.quote.request}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(depositState.quote.request)}
                >
                  Copy invoice
                </Button>
                <p className="text-sm text-muted-foreground">
                  {(depositState.quote.amountOre / 100).toFixed(2)} kr — waiting…
                </p>
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Polling for payment
                </div>
                <Button variant="outline" size="sm" onClick={cancelDeposit}>
                  Cancel
                </Button>
              </div>
            ) : depositState.quote.method === "btc" ? (
              <div className="grid gap-3 text-center">
                <p className="text-sm text-muted-foreground">
                  Send {depositState.quote.expectedSat ?? "…"} sat (signet) to:
                </p>
                <div className="flex justify-center">
                  <QrCodeImg text={depositState.quote.request} alt="Bitcoin address QR" />
                </div>
                <p className="break-all rounded-md bg-muted p-2 font-mono text-xs select-all">
                  {depositState.quote.request}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(depositState.quote.request)}
                >
                  Copy address
                </Button>
                <p className="text-sm text-muted-foreground">
                  {(depositState.quote.amountOre / 100).toFixed(2)} kr — waiting…
                </p>
                <OnchainStatus address={depositState.quote.request} />
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Polling for payment
                </div>
                <Button variant="outline" size="sm" onClick={cancelDeposit}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="grid gap-3 text-center">
                <p className="text-sm text-muted-foreground">
                  Give this code to the teller:
                </p>
                <div className="flex justify-center">
                  <QrCodeImg
                    text={depositState.quote.quoteId}
                    alt="Teller code QR — encodes the bare quote id"
                  />
                </div>
                <p className="font-mono text-3xl font-bold tracking-widest select-all">
                  {depositState.quote.tail}
                </p>
                <p className="text-sm text-muted-foreground">
                  {(depositState.quote.amountOre / 100).toFixed(2)} kr — waiting…
                </p>
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Polling for payment
                </div>
                <Button variant="outline" size="sm" onClick={cancelDeposit}>
                  Cancel
                </Button>
              </div>
            )
          ) : (
            <p className="text-sm text-destructive">{depositState.message}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowUp className="size-4" /> Withdraw
          </CardTitle>
          <CardDescription>
            Send ecash to a recipient via the teller.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {withdrawState.phase === "idle" || withdrawState.phase === "done" ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="wd-recipient">Recipient</Label>
                <Input
                  id="wd-recipient"
                  type="text"
                  placeholder="Phone or reference"
                  value={withdrawRecipient}
                  onChange={(e) => setWithdrawRecipient(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="wd-amt">Amount (kr)</Label>
                <Input
                  id="wd-amt"
                  type="number"
                  min="1"
                  max="1000"
                  step="0.01"
                  placeholder="1.00"
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                />
              </div>
              <Button
                variant="outline"
                onClick={startWithdraw}
                disabled={!withdrawAmount || !withdrawRecipient}
              >
                {withdrawState.phase === "done"
                  ? `✓ Paid — ${withdrawState.preimage}`
                  : "Send"}
              </Button>
            </>
          ) : withdrawState.phase === "creating" ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Creating…
            </div>
          ) : withdrawState.phase === "pending" ? (
            <div className="grid gap-3 text-center">
              <p className="text-sm text-muted-foreground">
                Give this code to the teller:
              </p>
              <p className="font-mono text-3xl font-bold tracking-widest select-all">
                {withdrawState.tail}
              </p>
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Waiting for payout
              </div>
            </div>
          ) : (
            <p className="text-sm text-destructive">{withdrawState.message}</p>
          )}
        </CardContent>
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-1">
              {history.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center justify-between py-1 text-sm"
                >
                  <span className="flex items-center gap-2">
                    {h.type === "deposit" ? (
                      <ArrowDown className="size-3" />
                    ) : (
                      <ArrowUp className="size-3" />
                    )}
                    <span className="text-muted-foreground">
                      {h.description}
                      {h.pending ? " (pending)" : ""}
                    </span>
                  </span>
                  <span
                    className={`font-mono tabular-nums ${h.pending ? "text-muted-foreground" : ""}`}
                  >
                    {h.type === "deposit" ? "+" : "−"}
                    {(h.amount_ore / 100).toFixed(2)} kr
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-center text-xs text-muted-foreground">
        Self-custodied — Coco 2 · keys stay in your browser.
        <br />
        <a href="/console/" className="underline">Operator console</a>
        {" · "}
        <a href="/teller/" className="underline">Teller</a>
      </p>
    </main>
  )
}
