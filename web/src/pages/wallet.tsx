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
  DEV_WALLET_TOOLS,
  downloadWalletDump,
  exportWalletDump,
  forceClearWallet,
  type HistoryRow,
  createDepositQuote,
  createWithdraw,
  getBalanceCents,
  getHistory,
  getPendingDeposits,
  cancelDepositQuote,
  getPendingWithdraw,
  pollAndMint,
  pollWithdraw,
  resumePendingOperations,
} from "@/lib/coco/coco-wallet"
import { getCoco } from "@/lib/coco/coco-wallet"
import {
  CURRENCIES,
  activeCurrency,
  consoleUrl,
  setActiveCurrency,
  type Currency,
} from "@/lib/coco/currency"

type DepositState =
  | { phase: "idle" }
  | { phase: "creating" }
  | { phase: "error"; message: string }

interface DepositReceipt {
  method: DepositMethod
  amount: number
  sat?: number
  address?: string
  currency: Currency
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

function OnchainStatus({
  address,
  currency,
}: {
  address: string
  currency?: Currency
}) {
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
        const res = await fetch(`${consoleUrl(currency)} /api/onchain-status/${address}`)
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
  const [currency, setCurrencyState] = useState<Currency>(activeCurrency)
  const [balance, setBalance] = useState<number | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [depositAmount, setDepositAmount] = useState("")
  const [depositMethod, setDepositMethod] = useState<"branch" | "ln" | "btc">("branch")
  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [withdrawRecipient, setWithdrawRecipient] = useState("")
  const [depositState, setDepositState] = useState<DepositState>({ phase: "idle" })
  const [pendingDeposits, setPendingDeposits] = useState<DepositQuote[]>([])
  const pendingRef = useRef<DepositQuote[]>([])
  pendingRef.current = pendingDeposits
  const [depositReceipt, setDepositReceipt] = useState<DepositReceipt | null>(null)
  const [withdrawState, setWithdrawState] = useState<WithdrawState>({ phase: "idle" })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async (c?: Currency) => {
    const currency = c ?? activeCurrency()
    try {
      const [balance, hist] = await Promise.all([
        getBalanceCents(currency),
        getHistory(15),
      ])
      setBalance(balance)
      setHistory(hist)
    } catch {
      // wallet not initialized yet
    }
  }, [])

  const switchCurrency = useCallback(
    (next: Currency) => {
      setActiveCurrency(next)
      setCurrencyState(next)
      setDepositState({ phase: "idle" })
      setWithdrawState({ phase: "idle" })
      void refresh(next)
    },
    [refresh],
  )

  useEffect(() => {
    let withdrawPollRef: ReturnType<typeof setInterval> | null = null

    getCoco()
      .then(async () => {
        refresh()

        // Restore every in-flight deposit card (all currencies) so a page
        // reload doesn't lose visual context — concurrent deposits on any
        // rail/currency pair are supported.
        const pending = await getPendingDeposits()
        if (pending.length > 0) {
          pendingRef.current = pending
          setPendingDeposits(pending)
          startDepositPolling()
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

  const startDepositPolling = () => {
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      const live = await Promise.all(
        pendingRef.current.map(async (q) => ({
          quote: q,
          done: await pollAndMint(q.quoteId, q.currency).catch(() => false),
        })),
      )
      const settled = live.filter((x) => x.done)
      if (settled.length > 0) {
        const last = settled[settled.length - 1].quote
        setPendingDeposits((prev) =>
          prev.filter((q) => !settled.some((x) => x.quote.quoteId === q.quoteId)),
        )
        setDepositReceipt({
          method: last.method,
          amount: last.amount,
          sat: last.expectedSat,
          address: last.method === "btc" ? last.request : undefined,
          currency: last.currency,
        })
        refresh()
        setTimeout(() => setDepositReceipt(null), 5000)
      }
      if (pendingRef.current.every((q) => settled.some((x) => x.quote.quoteId === q.quoteId))) {
        if (pollRef.current) clearInterval(pollRef.current)
        pollRef.current = null
      }
    }, 3000)
  }

  const cancelDepositCard = (quoteId: string) => {
    cancelDepositQuote(quoteId)
    setPendingDeposits((prev) => prev.filter((q) => q.quoteId !== quoteId))
  }

  const startDeposit = async () => {
    const amount = parseFloat(depositAmount)
    if (!amount || amount < 1 || amount > 1000) return
    setDepositState({ phase: "creating" })
    try {
      const quote = await createDepositQuote(amount, depositMethod)
      setDepositState({ phase: "idle" })
      setPendingDeposits((prev) => [...prev, quote])
      startDepositPolling()
    } catch (e) {
      console.error("deposit failed:", e)
      const msg = e instanceof Error ? e.message : String(e)
      // cdk flattens processor errors into vague messages; add context
      let helpful = msg
      if (msg.includes("Invalid payment request")) {
        helpful =
          "The mint rejected this deposit. The quote may have expired, the mint may have been reset, or the currency unit may have changed. Try cancelling any pending deposits and creating a fresh one."
      } else if (msg.includes("quote not found") || msg.includes("Unknown quote")) {
        helpful =
          "This quote no longer exists on the mint (it may have expired or the mint was restarted). Please create a new deposit."
      } else if (msg.includes("Unit mismatch") || msg.includes("Unsupported unit")) {
        helpful =
          `The mint doesn't support the currency unit this wallet is configured for. Expected: ${activeCurrency().toUpperCase()}. The mint may have been re-denominated.`
      }
      setDepositState({ phase: "error", message: helpful })
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

  const balanceText = balance !== null ? (balance / 100).toFixed(2) : "…"
  const symbol = CURRENCIES[currency].symbol
  const isDark = document.documentElement.classList.contains("dark")

  return (
    <main className="mx-auto grid min-h-screen max-w-lg gap-4 px-4 py-8">
      <div className="flex items-center gap-2">
        <WalletIcon className="size-5" />
        <h1 className="text-lg font-semibold">Wallet</h1>
        <div className="ml-auto flex items-center gap-1" role="tablist" aria-label="Currency">
          {(Object.keys(CURRENCIES) as Currency[]).map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={c === currency}
              onClick={() => switchCurrency(c)}
              className={
                "rounded-md px-2 py-1 text-xs font-medium " +
                (c === currency
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted")
              }
            >
              {CURRENCIES[c].label}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardDescription>Balance</CardDescription>
          <CardTitle className="text-4xl tabular-nums">
            {balanceText} <span className="text-base font-normal text-muted-foreground">{symbol}</span>
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
          {depositReceipt ? (
            <div className="grid gap-3 rounded-lg border border-green-200 bg-green-50 p-4 text-center dark:border-green-900 dark:bg-green-950">
              <div className="text-2xl">✓</div>
              <p className="font-medium text-green-700 dark:text-green-300">
                Deposit confirmed
              </p>
              <p className="text-lg font-bold">
                +{(depositReceipt.amount / 100).toFixed(2)}{" "}
                {CURRENCIES[depositReceipt.currency].symbol}
              </p>
              <div className="text-xs text-muted-foreground">
                {depositReceipt.method === "btc" && depositReceipt.sat && (
                  <p>{depositReceipt.sat.toLocaleString()} sat on-chain</p>
                )}
                {depositReceipt.method === "ln" && <p>Lightning payment</p>}
                {depositReceipt.method === "branch" && <p>Teller settlement</p>}
              </div>
              {depositReceipt.method === "btc" && depositReceipt.address && (
                <a
                  href={`https://mempool.space/signet/address/${depositReceipt.address}`}
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
                onClick={() => setDepositReceipt(null)}
              >
                New deposit
              </Button>
            </div>
          ) : depositState.phase === "idle" ? (
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
                  Minimum 50 {symbol} — on-chain deposits pay for dust and chain fees.
                </p>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="dep-amt">Amount ({symbol})</Label>
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
                {depositMethod === "ln"
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
          ) : (
            <p className="text-sm text-destructive">{depositState.message}</p>
          )}

          {pendingDeposits.map((q) => {
            const cardSymbol = CURRENCIES[q.currency].symbol
            return (
              <div
                key={q.quoteId}
                className="grid gap-3 rounded-lg border p-4 text-center"
                data-testid="deposit-card"
              >
                {q.currency !== currency && (
                  <p className="text-xs text-muted-foreground">
                    {CURRENCIES[q.currency].label} deposit
                  </p>
                )}
                {q.method === "ln" ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Pay this lightning invoice (signet):
                    </p>
                    <div className="flex justify-center">
                      <QrCodeImg text={q.request} alt="Lightning invoice QR" />
                    </div>
                    <p className="max-h-24 overflow-y-auto break-all rounded-md bg-muted p-2 font-mono text-xs select-all">
                      {q.request}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigator.clipboard.writeText(q.request)}
                    >
                      Copy invoice
                    </Button>
                  </>
                ) : q.method === "btc" ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Send {q.expectedSat ?? "…"} sat (signet) to:
                    </p>
                    <div className="flex justify-center">
                      <QrCodeImg text={q.request} alt="Bitcoin address QR" />
                    </div>
                    <p className="break-all rounded-md bg-muted p-2 font-mono text-xs select-all">
                      {q.request}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigator.clipboard.writeText(q.request)}
                    >
                      Copy address
                    </Button>
                    <OnchainStatus address={q.request} currency={q.currency} />
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Give this code to the teller:
                    </p>
                    <div className="flex justify-center">
                      <QrCodeImg
                        text={q.quoteId}
                        alt="Teller code QR — encodes the bare quote id"
                      />
                    </div>
                    <p className="font-mono text-3xl font-bold tracking-widest select-all">
                      {q.tail}
                    </p>
                  </>
                )}
                <p className="text-sm text-muted-foreground">
                  {(q.amount / 100).toFixed(2)} {cardSymbol} — waiting…
                </p>
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Polling for payment
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => cancelDepositCard(q.quoteId)}
                >
                  Cancel
                </Button>
              </div>
            )
          })}
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
                <Label htmlFor="wd-amt">Amount ({symbol})</Label>
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
                    {(h.amount / 100).toFixed(2)} {symbol}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {DEV_WALLET_TOOLS && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-destructive">
              Developer Tools
            </CardTitle>
            <CardDescription className="text-xs">
              Signet/test only. These actions are irreversible.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const dump = await exportWalletDump()
                downloadWalletDump(dump)
              }}
            >
              Export wallet data (JSON)
            </Button>
            <Button
              variant="outline" className="text-destructive border-destructive hover:bg-destructive hover:text-white"
              size="sm"
              onClick={async () => {
                const dump = await exportWalletDump()
                downloadWalletDump(dump)
                await new Promise((r) => setTimeout(r, 500))
                await forceClearWallet()
                window.location.reload()
              }}
            >
              Force clear wallet (downloads backup first)
            </Button>
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
