// Wallet debug logging: a bounded ring buffer of wallet lifecycle events,
// mirrored to the JS console when debugging is on (?debug=1 or localStorage
// "pecan-debug"). The e2e suite dumps the buffer into the Playwright
// artifacts on failure — client-side state transitions are otherwise
// invisible in post-mortems (op state, quote state, proof lifecycle).
//
// Always collected (cheap, no console noise unless enabled): the error gate
// in the e2e helpers only trips on console.error, and console.debug output
// is opt-in.

import type { CoreEvents } from "@cashu/coco-core"

export interface WalletLogEntry {
  t: number
  level: "debug" | "info" | "warn"
  msg: string
  data?: unknown
}

const MAX_ENTRIES = 400
const buffer: WalletLogEntry[] = []

function debugEnabled(): boolean {
  if (typeof window === "undefined") return false
  return (
    window.location.search.includes("debug=1") ||
    window.localStorage.getItem("pecan-debug") === "1"
  )
}

// Payloads carry Amount/Proof objects with cycles and bigints; keep the
// log serializable and bounded.
function safeData(data: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(data, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    )
  } catch {
    return String(data)
  }
}

export function walletLog(
  level: WalletLogEntry["level"],
  msg: string,
  data?: unknown,
): void {
  const entry: WalletLogEntry = { t: Date.now(), level, msg }
  if (data !== undefined) entry.data = safeData(data)
  buffer.push(entry)
  if (buffer.length > MAX_ENTRIES) buffer.shift()
  if (debugEnabled()) {
    // eslint-disable-next-line no-console -- explicit debug channel
    console.debug(`[pecan] ${msg}`, entry.data ?? "")
  }
}

export function getWalletLog(): WalletLogEntry[] {
  return [...buffer]
}

if (typeof window !== "undefined") {
  // cross-context handle for the e2e failure dump
  (window as { __pecanWalletLog?: () => WalletLogEntry[] }).__pecanWalletLog =
    getWalletLog
}

/** Operation/quote events worth a log line, from the coco event bus. */
const OP_EVENTS = [
  "melt-op:prepared",
  "melt-op:pending",
  "melt-op:finalized",
  "melt-op:rolled-back",
  "mint-op:pending",
  "mint-op:executing",
  "mint-op:finalized",
  "mint-op:failed",
  "mint-op:requeue",
  "melt-quote:updated",
  "mint-quote:updated",
  "proofs:state-changed",
] as const satisfies readonly (keyof CoreEvents)[]

type OpEvent = (typeof OP_EVENTS)[number]

export function subscribeWalletLogging(
  bus: { on<K extends keyof CoreEvents>(event: K, handler: (payload: CoreEvents[K]) => void): void },
): void {
  for (const event of OP_EVENTS) {
    bus.on(event, (payload) => {
      const op = payload as {
        operation?: { id?: string; state?: string }
        quote?: { quoteId?: string; state?: string }
      }
      const id = op?.operation?.id ?? op?.quote?.quoteId
      const state = op?.operation?.state ?? op?.quote?.state
      walletLog("debug", event satisfies OpEvent, id ? { id, state } : payload)
    })
  }
}
