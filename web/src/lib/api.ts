export type TicketKind = "incoming" | "outgoing"
export type TicketStatus = "offered" | "waiting" | "pending" | "paid" | "failed"

export interface HealthItem {
  ok: boolean
  label: string
  detail: string
}

export interface KeysetEntry {
  id: string
  unit: string
  active: boolean
  input_fee_ppk: number
  final_expiry?: number | null
}

export type UnitLifecycle = "active" | "redemption_only" | "retired"

export interface RolloverPolicy {
  enabled: boolean
  keyset_lifetime_days: number
  rotate_before_expiry_days: number
  input_fee_ppk: number
  amounts: number[]
}

export interface ManagedUnit {
  unit: string
  lifecycle: UnitLifecycle
  configured_at: number
  rollover: RolloverPolicy
  keyset_count: number
  active_keyset?: KeysetEntry | null
  can_mint: boolean
  can_melt: boolean
}

export interface Capability {
  unit: string
  method: string
  mint: boolean
  melt: boolean
  managed: boolean
}

export interface ConsistencyState {
  ok: boolean
  issues: string[]
}

export interface UnitSummary {
  unit: string
  mint_count: number
  melt_count: number
  minted_amount: number
  melted_amount: number
  net_issued: number
}

export interface Ticket {
  id: string
  short_id: string
  kind: TicketKind
  kind_label: string
  amount: number
  unit: string
  status: TicketStatus
  status_label: string
  created_at: number
  paid_at?: number | null
  expires_at?: number | null
  description?: string | null
  notes?: string | null
  /** Serialized NUT-XX quote offer (`cquoteA...`) — the only thing shown to the wallet. */
  offer?: string | null
  /** QR of the offer; present while the offer is unclaimed. */
  qr_svg?: string | null
  /** Payout verification code for funded cash-dispense tickets. */
  verification_code?: string | null
}

export interface CirculationPoint {
  ts: number
  ticket_id: string
  kind: TicketKind
  amount: number
  delta: number
  circulation: number
}

export interface AppSnapshot {
  now: number
  mint: {
    name: string
    description: string
    description_long: string
    unit: string
    method: string
  }
  endpoints: {
    public_url: string
    mint_http_url: string
    mint_rpc_url: string
    processor_grpc_addr: string
    processor_grpc_port: number
  }
  rollover: RolloverPolicy
  default_amounts: number[]
  health: {
    mint_http: HealthItem
    management_rpc: HealthItem
    payment_backend: HealthItem
  }
  keysets: {
    ok: boolean
    items: KeysetEntry[]
    error?: string | null
  }
  active_keyset?: KeysetEntry | null
  summary: {
    mint_count: number
    melt_count: number
    minted_amount: number
    melted_amount: number
    net_issued: number
  }
  unit_summaries: UnitSummary[]
  circulation: CirculationPoint[]
  tickets: Ticket[]
  active_tickets: Ticket[]
  recent_done: Ticket[]
  units: ManagedUnit[]
  capabilities: Capability[]
  consistency: ConsistencyState
}

export interface SetupDefaults {
  name: string
  description: string
  description_long: string
  unit: string
  method: string
  public_url: string
  password_min_length: number
  mnemonic: string
  rollover_enabled: boolean
  keyset_lifetime_days: number
  rotate_before_expiry_days: number
  input_fee_ppk: number
  amounts: string
}

export class ApiRequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiRequestError"
    this.status = status
  }
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers,
  })
  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch (_) {
      data = { error: text }
    }
  }

  if (!response.ok) {
    const body = data as { error?: string } | null
    throw new ApiRequestError(response.status, body?.error ?? response.statusText)
  }
  return data as T
}

export function apiPost<T>(path: string, body?: unknown) {
  return requestJson<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
