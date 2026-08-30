import { useCallback, useEffect, useRef, useState } from "react"
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
  createDepositQuote,
  createWithdraw,
  getBalanceCents,
  getHistory,
  getWallet,
  pollAndMint,
  pollWithdraw,
} from "@/lib/wallet"

interface HistoryRow {
  id?: number
  type: "deposit" | "withdraw"
  amount: number
  description: string
  created_at: number
}

type DepositState =
  | { phase: "idle" }
  | { phase: "creating" }
  | { phase: "pending"; quote: DepositQuote }
  | { phase: "done" }
  | { phase: "error"; message: string }

type WithdrawState =
  | { phase: "idle" }
  | { phase: "creating" }
  | { phase: "pending"; quoteId: string; tail: string }
  | { phase: "done"; preimage: string }
  | { phase: "error"; message: string }

export function WalletClassicPage() {
  const [balance, setBalance] = useState<number | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [depositAmount, setDepositAmount] = useState("")
  const [withdrawAmount, setWithdrawAmount] = useState("")
  const [withdrawRecipient, setWithdrawRecipient] = useState("")
  const [depositState, setDepositState] = useState<DepositState>({ phase: "idle" })
  const [withdrawState, setWithdrawState] = useState<WithdrawState>({ phase: "idle" })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [ore, hist] = await Promise.all([getBalanceCents(), getHistory(15)])
      setBalance(ore)
      setHistory(hist)
    } catch {
      // wallet not initialized yet
    }
  }, [])

  useEffect(() => {
    getWallet().then(() => refresh()).catch(() => {}).finally(() => refresh())
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refresh])

  const startDeposit = async () => {
    const amount = parseFloat(depositAmount)
    if (!amount || amount < 1 || amount > 1000) return
    setDepositState({ phase: "creating" })
    try {
      const quote = await createDepositQuote(amount)
      setDepositState({ phase: "pending", quote })

      pollRef.current = setInterval(async () => {
        const done = await pollAndMint(quote.quoteId, quote.amount, quote.privkey)
        if (done) {
          clearInterval(pollRef.current!)
          pollRef.current = null
          setDepositState({ phase: "done" })
          refresh()
          setTimeout(() => setDepositState({ phase: "idle" }), 3000)
        }
      }, 3000)
    } catch (e) {
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
            Create a quote, give the code to the teller, receive ecash.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {depositState.phase === "idle" || depositState.phase === "done" ? (
            <>
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
                {depositState.phase === "done" ? "✓ Deposited" : "Create deposit quote"}
              </Button>
            </>
          ) : depositState.phase === "creating" ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Creating quote…
            </div>
          ) : depositState.phase === "pending" ? (
            <div className="grid gap-3 text-center">
              <p className="text-sm text-muted-foreground">
                Give this code to the teller:
              </p>
              <p className="font-mono text-3xl font-bold tracking-widest select-all">
                {depositState.quote.tail}
              </p>
              <p className="text-sm text-muted-foreground">
                {(depositState.quote.amount / 100).toFixed(2)} kr — waiting…
              </p>
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Polling for payment
              </div>
            </div>
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
                    <span className="text-muted-foreground">{h.description}</span>
                  </span>
                  <span className="font-mono tabular-nums">
                    {h.type === "deposit" ? "+" : "−"}
                    {(h.amount / 100).toFixed(2)} kr
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-center text-xs text-muted-foreground">
        Self-custodied — keys stay in your browser.
        <br />
        <a href="/console/" className="underline">Operator console</a>
        {" · "}
        <a href="/teller/" className="underline">Teller</a>
      </p>
    </main>
  )
}
