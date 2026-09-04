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
  claimOrphanedEvRefunds,
  getRecentChargedSessionWithRetry,
} from "@/lib/coco/coco-wallet"
import { parseChargeReceipt, refundEuros } from "@/lib/coco/charge-session"
import { downloadWalletDump, exportWalletDump } from "@/lib/coco/wallet-backup"
import { BackupCard } from "@/components/wallet/backup-card"
import { ExpiryCountdown } from "@/components/wallet/expiry-countdown"
import {
  MultiTabBanner,
  useMultiTabWarning,
} from "@/components/wallet/multi-tab-banner"
import { getCoco } from "@/lib/coco/coco-wallet"
import {
  CURRENCIES,
  activeCurrency,
  consoleUrl,
  setActiveCurrency,
  type Currency,
} from "@/lib/coco/currency"
import {
  validateDepositAmount,
  validateWithdrawAmount,
} from "@/lib/amount-validation"

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
  | { phase: "pending"; quoteId: string; tail: string; auto: boolean; label: string }
  | { phase: "charging"; label: string; device: string; budget: number; delivered: number; requested: number; ref: string }
  | { phase: "done"; preimage: string }
  | { phase: "charged"; label: string; seconds: number; spent: number; refunded: number; stopped: boolean; receipt: string | null }
  | { phase: "error"; message: string }

/**
 * Withdraw destinations: the teller rail (human) plus the deployment's
 * payout rails — the simulated rails settle automatically and hand back
 * the scheme's receipt as the payment proof; the demo EV chargers are
 * fixed-destination rails (the envelope is complete, no destination
 * input — the charger itself is the offramp, 1 € = 1 kW·s).
 */
const WITHDRAW_OPTIONS = [
  {
    id: "teller",
    label: "Teller",
    placeholder: "Phone or reference",
    fixed: null,
    hint: "Send ecash to a recipient via the teller.",
  },
  {
    id: "sepa",
    label: "SEPA",
    placeholder: "IBAN, e.g. NL33INGB0000000881",
    fixed: null,
    hint: "Bank transfer — settles with an E2E reference as receipt.",
  },
  {
    id: "sepa-instant",
    label: "Instant",
    placeholder: "IBAN, e.g. DE96370205000003292912",
    fixed: null,
    hint: "SEPA instant — settles with a UETR receipt.",
  },
  {
    id: "swish",
    label: "Swish",
    placeholder: "+46…",
    fixed: null,
    hint: "Mobile bank payment (SE) — Swish reference receipt.",
  },
  {
    id: "mobilepay",
    label: "MobilePay",
    placeholder: "+45… / +358…",
    fixed: null,
    hint: "Mobile wallet (DK/FI) — transaction-id receipt.",
  },
  {
    id: "ideal",
    label: "iDEAL",
    placeholder: "NL IBAN",
    fixed: null,
    hint: "Dutch instant bank rail — transaction-id receipt.",
  },
  {
    id: "bizum",
    label: "Bizum",
    placeholder: "+34…",
    fixed: null,
    hint: "Spanish mobile rail — operation-reference receipt.",
  },
  {
    id: "sim",
    label: "Sim",
    placeholder: "alias",
    fixed: null,
    hint: "Generic simulated rail — token receipt.",
  },
  {
    id: "atomA",
    label: "Charger A",
    placeholder: null,
    fixed: "ev:atomA",
    hint: "Demo EV charger — 1 € = 1 kW·s of charging, fires on send.",
  },
  {
    id: "atomB",
    label: "Charger B",
    placeholder: null,
    fixed: "ev:atomB",
    hint: "Demo EV charger — 1 € = 1 kW·s of charging, fires on send.",
  },
] as const

type WithdrawRail = (typeof WITHDRAW_OPTIONS)[number]["id"]

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
        const res = await fetch(`${consoleUrl(currency)}/api/onchain-status/${address}`)
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
  const [withdrawRail, setWithdrawRail] = useState<WithdrawRail>("teller")
  const [depositState, setDepositState] = useState<DepositState>({ phase: "idle" })
  const [pendingDeposits, setPendingDeposits] = useState<DepositQuote[]>([])
  const pendingRef = useRef<DepositQuote[]>([])
  pendingRef.current = pendingDeposits
  const [depositReceipt, setDepositReceipt] = useState<DepositReceipt | null>(null)
  const [withdrawState, setWithdrawState] = useState<WithdrawState>({ phase: "idle" })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const multiTab = useMultiTabWarning()

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
      // Blank the stale figure immediately — until the next currency's
      // balance loads, the card must show "…", never the previous
      // currency's number under the new tab.
      setBalance(null)
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

        // Crash recovery for the deposit pattern: a reload mid-session
        // orphans the in-page refund claim. Re-claim from history; the
        // daemon's ledger makes this idempotent.
        void claimOrphanedEvRefunds().then((euros) => {
          if (euros >= 1) refresh()
        })

        const pendingWithdraw = await getPendingWithdraw()
        if (!pendingWithdraw) {
          // A reload that lands after the melt finalized still deserves
          // the summary; re-derive it from the recent finalized session.
          const recent = await getRecentChargedSessionWithRetry().catch(() => null)
          if (recent) {
            setWithdrawState({
              phase: "charged",
              label: recent.label,
              seconds: recent.seconds,
              spent: recent.seconds,
              refunded: recent.refunded,
              stopped: recent.stopped,
              receipt: recent.receipt,
            })
          }
        }
        if (pendingWithdraw) {
          // Resume shows the charging state when the melt's envelope names
          // a fixed-destination rail (ev:atomA); otherwise the teller code.
          const resumedOption = WITHDRAW_OPTIONS.find(
            (o) => o.fixed && o.fixed === pendingWithdraw.description,
          )
          setWithdrawState({
            phase: "pending",
            quoteId: pendingWithdraw.quoteId,
            tail: pendingWithdraw.tail,
            auto: Boolean(resumedOption),
            label: resumedOption?.label ?? "payout",
          })
          withdrawPollRef = setInterval(async () => {
            const preimage = await pollWithdraw(pendingWithdraw.quoteId)
            if (preimage) {
              if (withdrawPollRef) clearInterval(withdrawPollRef)
              withdrawPollRef = null
              // A finalized ev melt resumes into the charged summary
              // (delivered seconds + refund), not the generic receipt
              // card — the session's meaning survives the reload.
              if (resumedOption?.fixed?.startsWith("ev:")) {
                const recent = await getRecentChargedSessionWithRetry().catch(() => null)
                if (recent) {
                  setWithdrawState({
                    phase: "charged",
                    label: recent.label,
                    seconds: recent.seconds,
                    spent: recent.seconds,
                    refunded: recent.refunded,
                    stopped: recent.stopped,
                    receipt: recent.receipt,
                  })
                  refresh()
                  return
                }
              }
              setWithdrawState({ phase: "done", preimage })
              refresh()
              setTimeout(() => setWithdrawState({ phase: "idle" }), 60_000)
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
    const invalidAmount = validateDepositAmount(
      depositAmount,
      depositMethod,
      CURRENCIES[currency].symbol,
    )
    if (invalidAmount) {
      setDepositState({ phase: "error", message: invalidAmount })
      return
    }
    const amount = parseFloat(depositAmount)
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

  // Streaming charge sessions (design A in docs/payout-modules.md): the
  // wallet melts one €1 chunk (= one tariffed second) at a time and only
  // melts the next after the current one settles. Stop = don't melt the
  // next chunk — the un-melted budget never left the wallet, so partial
  // sessions need no refund path at all.
  // Deposit-pattern charge sessions (docs/partial-delivery.md § deposit):
  // ONE melt for the whole budget is the deposit; the charger meters
  // actual delivery; the wallet's Stop (or the device's button) ends the
  // session; the daemon settles the melt at full and the wallet claims
  // the un-consumed remainder as a refund mint quote the daemon settles.
  // The slider polls the gateway's public session endpoint — the melt
  // quote id is the capability — so no operator secret ships in the
  // browser bundle.
  const chargeAbort = useRef(false)

  const sessionStatus = async (ref: string) => {
    try {
      const r = await fetch(`/atom-gateway/session/${ref}/status`)
      if (!r.ok) return null
      return (await r.json()) as {
        state: string
        delivered: number
        remaining: number
        requested: number
        stopped: boolean
      }
    } catch {
      return null
    }
  }

  const stopSession = async (ref: string) => {
    try {
      const r = await fetch(`/atom-gateway/session/${ref}/stop`, { method: "POST" })
      return r.ok
    } catch {
      return false
    }
  }

  const startCharging = async (
    option: (typeof WITHDRAW_OPTIONS)[number],
    budget: number,
  ) => {
    const device = option.fixed!.split(":")[1] ?? option.id
    chargeAbort.current = false
    let receipt: string | null = null

    let result
    try {
      result = await createWithdraw(budget, option.fixed!)
    } catch (e) {
      setWithdrawState({
        phase: "error",
        message: e instanceof Error ? e.message : String(e),
      })
      return
    }
    const ref = result.quoteId

    // The finalize poll (receipt) and the slider poll run concurrently;
    // whichever resolves the session first wins.
    const finalize = (async () => {
      const deadline = Date.now() + 600_000
      while (Date.now() < deadline) {
        const preimage = await pollWithdraw(ref)
        if (preimage) return preimage
        await new Promise((r) => setTimeout(r, 1_500))
      }
      return null
    })()

    const slider = (async () => {
      while (!chargeAbort.current) {
        const st = await sessionStatus(ref)
        if (st) {
          setWithdrawState({
            phase: "charging",
            label: option.label,
            device,
            budget,
            delivered: st.delivered,
            requested: st.requested,
            ref,
          })
          if (st.state !== "running") return
        }
        await new Promise((r) => setTimeout(r, 1_000))
      }
    })()

    receipt = await finalize
    chargeAbort.current = true
    await Promise.race([slider, new Promise((r) => setTimeout(r, 2_000))])
    refresh()

    if (!receipt || receipt === "FAILED") {
      setWithdrawState({
        phase: "error",
        message: receipt
          ? "The charger session failed — check history."
          : "The session did not settle in time — it stays pending and resolves on reload.",
      })
      return
    }

    const parsed = parseChargeReceipt(receipt)
    const delivered = parsed?.deliveredSeconds ?? budget
    const stopped = parsed?.stopped ?? false
    const spent = Math.min(budget, delivered)
    const claimable = refundEuros(budget, delivered)

    let refunded = 0
    if (claimable >= 1) {
      try {
        // The refund is a fresh locked mint quote the daemon settles
        // against its delivery ledger (one per melt, capped at the
        // un-consumed amount); the existing deposit machinery claims it.
        const centsBeforeClaim = await getBalanceCents(currency)
        const refundQuote = await createDepositQuote(
          claimable,
          "branch",
          currency,
          `refund:${ref}`,
        )
        const deadline = Date.now() + 180_000
        while (Date.now() < deadline) {
          if (await pollAndMint(refundQuote.quoteId)) break
          await new Promise((r) => setTimeout(r, 1_500))
        }
        // pollAndMint reports terminal states, including FAILED — prove
        // the refund with the balance before telling the user it landed
        // (a failed claim surfaces as a pending deposit card instead).
        const centsAfterClaim = await getBalanceCents(currency)
        if (centsAfterClaim - centsBeforeClaim >= claimable * 100 - 1) {
          refunded = claimable
        }
      } catch (e) {
        // Claim failures surface as an unsettled deposit card — the
        // refund is recoverable from history; do not fail the summary.
        console.error("refund claim failed:", e)
      }
    }
    refresh()
    setWithdrawState({
      phase: "charged",
      label: option.label,
      seconds: delivered,
      spent,
      refunded,
      stopped,
      receipt,
    })
  }

  const startWithdraw = async () => {
    const option = WITHDRAW_OPTIONS.find((o) => o.id === withdrawRail)
    const invalidAmount = validateWithdrawAmount(
      withdrawAmount,
      CURRENCIES[currency].symbol,
      balance,
    )
    if (invalidAmount) {
      setWithdrawState({ phase: "error", message: invalidAmount })
      return
    }
    // Fixed-destination rails (the demo chargers) carry a complete
    // envelope — there is no destination input to validate.
    if (!option?.fixed && !withdrawRecipient.trim()) {
      setWithdrawState({
        phase: "error",
        message:
          withdrawRail === "teller"
            ? "Enter a phone number or reference for the teller."
            : "Enter a destination for this rail.",
      })
      return
    }
    const amount = parseFloat(withdrawAmount)
    // Charger rails stream: the amount is the budget, melted a second at
    // a time so a stop never strands prepaid energy.
    if (option?.fixed?.startsWith("ev:")) {
      await startCharging(option, Math.round(amount))
      return
    }
    // Input rails ride the payout envelope: rail:destination.
    const target =
      option?.fixed ??
      (withdrawRail === "teller"
        ? withdrawRecipient.trim()
        : `${withdrawRail}:${withdrawRecipient.trim()}`)
    setWithdrawState({ phase: "creating" })
    try {
      const result = await createWithdraw(amount, target)
      setWithdrawState({
        phase: "pending",
        quoteId: result.quoteId,
        tail: result.tail,
        // Fixed-destination rails settle themselves (the charger daemon):
        // no teller code to hand over, the charger is already firing.
        auto: Boolean(option?.fixed),
        label: option?.label ?? "payout",
      })
      refresh()

      const interval = setInterval(async () => {
        const preimage = await pollWithdraw(result.quoteId)
        if (preimage) {
          clearInterval(interval)
          setWithdrawState({ phase: "done", preimage })
          refresh()
          // The receipt reference is the proof of payment — leave it up
          // long enough to read and copy.
          setTimeout(() => setWithdrawState({ phase: "idle" }), 60_000)
        }
      }, 3000)

      return () => clearInterval(interval)
    } catch (e) {
      console.error("withdraw failed:", e)
      const msg = e instanceof Error ? e.message : String(e)
      // pass the server's message through, adding context only where cdk
      // flattens it into something vague
      let helpful = msg
      if (msg.includes("Amount out of limit")) {
        helpful = `The mint rejected this amount — withdrawals are limited to 1–1000 ${CURRENCIES[currency].symbol}.`
      } else if (msg.toLowerCase().includes("insufficient")) {
        helpful =
          "Not enough funds for this withdrawal (the balance may be stale — try again)."
      } else if (msg.includes("Unit unsupported")) {
        // cdk flattens any melt-quote refusal (including payout-rail
        // gates) into this generic text — name the likely cause.
        helpful =
          "The mint refused this payout destination — the rail may not be enabled here. Try a plain destination for the teller."
      }
      setWithdrawState({ phase: "error", message: helpful })
    }
  }

  const balanceText = balance !== null ? (balance / 100).toFixed(2) : "…"
  const activeOption = WITHDRAW_OPTIONS.find((o) => o.id === withdrawRail)
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

      <MultiTabBanner visible={multiTab} />

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
            <div className="grid gap-2">
              <p className="text-sm text-destructive">{depositState.message}</p>
              <Button
                variant="outline"
                onClick={() => setDepositState({ phase: "idle" })}
              >
                Try again
              </Button>
            </div>
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
                    <ExpiryCountdown createdAt={q.createdAt} />
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
            {WITHDRAW_OPTIONS.find((o) => o.id === withdrawRail)?.hint}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {withdrawState.phase === "idle" || withdrawState.phase === "done" ? (
            <>
              <div
                className="grid grid-cols-3 gap-1.5 rounded-lg bg-muted p-1 text-sm"
                role="tablist"
                aria-label="Withdraw rail"
              >
                {WITHDRAW_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    role="tab"
                    type="button"
                    aria-selected={withdrawRail === o.id}
                    onClick={() => setWithdrawRail(o.id)}
                    className={`rounded-md px-2 py-1.5 transition-colors ${
                      withdrawRail === o.id
                        ? "bg-background font-medium shadow-sm"
                        : "text-muted-foreground"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {activeOption?.placeholder ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="wd-recipient">Destination</Label>
                  <Input
                    id="wd-recipient"
                    type="text"
                    placeholder={activeOption.placeholder}
                    value={withdrawRecipient}
                    onChange={(e) => setWithdrawRecipient(e.target.value)}
                  />
                </div>
              ) : null}
              <div className="grid gap-1.5">
                <Label htmlFor="wd-amt">
                  {activeOption?.fixed?.startsWith("ev:")
                    ? `Budget (${symbol})`
                    : `Amount (${symbol})`}
                </Label>
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
              {withdrawState.phase === "done" ? (
                <div className="grid gap-2 rounded-md border p-3 text-center">
                  <p className="break-all font-mono text-sm">
                    {withdrawState.preimage}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Receipt — your proof of payment
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setWithdrawState({ phase: "idle" })}
                  >
                    New withdraw
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  onClick={startWithdraw}
                  disabled={!withdrawAmount || (!activeOption?.fixed && !withdrawRecipient)}
                >
                  {activeOption?.fixed?.startsWith("ev:") ? "Start charging" : "Send"}
                </Button>
              )}
            </>
          ) : withdrawState.phase === "creating" ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Creating…
            </div>
          ) : withdrawState.phase === "pending" ? (
            withdrawState.auto ? (
              <div className="grid gap-3 text-center">
                <p className="text-lg font-medium">
                  ⚡ Charging at {withdrawState.label}
                </p>
                <p className="text-sm text-muted-foreground">
                  The charger is delivering — this settles by itself when
                  the charge window completes.
                </p>
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Charging
                </div>
              </div>
            ) : (
              <div className="grid gap-3 text-center">
                <p className="text-sm text-muted-foreground">
                  Give this code to the teller:
                </p>
                <p className="font-mono text-3xl font-bold tracking-widest select-all">
                  {withdrawState.tail}
                </p>
                <div className="flex justify-center">
                  <QrCodeImg text={withdrawState.tail} alt="Teller code QR" />
                </div>
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Waiting for payout
                </div>
              </div>
            )
           ) : withdrawState.phase === "charging" ? (
              <div className="grid gap-3 text-center">
                <p className="text-lg font-medium">
                  ⚡ Charging at {withdrawState.label}
                </p>
                <p className="text-3xl font-bold tabular-nums">
                  {withdrawState.delivered}
                  <span className="text-base font-normal text-muted-foreground">
                    {" "}
                    / {withdrawState.requested || withdrawState.budget} s
                  </span>
                </p>
                <div
                  className="relative h-3 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={withdrawState.requested || withdrawState.budget}
                  aria-valuenow={withdrawState.delivered}
                >
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-1000"
                    style={{
                      width: `${Math.min(
                        100,
                        (withdrawState.delivered /
                          Math.max(1, withdrawState.requested || withdrawState.budget)) *
                          100,
                      )}%`,
                    }}
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  {`≈ €${Math.max(
                    0,
                    withdrawState.budget - withdrawState.delivered,
                  )}.00 of the deposit remaining`}
                </p>
                <p className="text-xs text-muted-foreground">
                  Deposit €
                  {withdrawState.budget}
                  .00 · 1 € per second — the unspent part refunds
                  automatically when the session ends.
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    void stopSession(withdrawState.ref)
                  }}
                >
                  Stop charging
                </Button>
              </div>
          ) : withdrawState.phase === "charged" ? (
              <div className="grid gap-2 rounded-md border p-3 text-center">
                <p className="font-medium">
                  {withdrawState.stopped
                    ? `Charging stopped — ${withdrawState.seconds} s delivered`
                    : `Charged ${withdrawState.seconds} s at ${withdrawState.label}`}
                </p>
                <p className="text-sm text-muted-foreground">
                  €{withdrawState.spent}.00 spent
                  {withdrawState.refunded >= 1
                    ? ` · €${withdrawState.refunded}.00 refunded to your wallet`
                    : withdrawState.stopped
                      ? " — the unspent deposit refunded automatically"
                      : ""}
                </p>
                {withdrawState.receipt ? (
                  <>
                    <p className="break-all font-mono text-sm">
                      {withdrawState.receipt}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Session record — your proof of charging
                    </p>
                  </>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setWithdrawState({ phase: "idle" })}
                >
                  New withdraw
                </Button>
              </div>
          ) : (
            <div className="grid gap-2">
              <p className="text-sm text-destructive">{withdrawState.message}</p>
              <Button
                variant="outline"
                onClick={() => setWithdrawState({ phase: "idle" })}
              >
                Try again
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <BackupCard />

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
