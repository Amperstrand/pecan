export type TicketKind = "incoming" | "outgoing"
export type TicketStatus = "waiting" | "pending" | "paid" | "failed"

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

/** Audited supply for one unit, read from the mint database per keyset. */
export interface UnitSupply {
  unit: string
  /** Redeemable ecash outstanding under non-expired keysets. */
  live: number
  /** Ecash stranded under keysets past their final expiry. */
  demonetized: number
  /** Value burned as input fees. */
  fee_collected: number
}

export interface SupplySnapshot {
  available: boolean
  error?: string | null
  units: UnitSupply[]
}

export interface Ticket {
  id: string
  short_id: string
  /** The mint's quote id — what the customer's wallet displays. */
  quote_id?: string | null
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
}

/**
 * Redacted row of the teller's open-quote list. Only the leading characters of
 * the quote id are shipped — matching requires the trailing characters, which
 * must come from the customer's wallet.
 */
export interface OpenQuoteSummary {
  prefix: string
  kind: TicketKind
  kind_label: string
  amount: number
  unit: string
  status: TicketStatus
  status_label: string
  created_at: number
  expires_at?: number | null
}

export interface CirculationPoint {
  ts: number
  ticket_id: string
  kind: TicketKind
  amount: number
  delta: number
  circulation: number
}

export interface UserEntry {
  username: string
  created_at: number
}

export type MintConnectionMode = "bundled" | "unset" | "external"

export interface MintConnectionInfo {
  mode: MintConnectionMode
  http_url?: string | null
  rpc_url?: string | null
  advertised_grpc?: string | null
  /** Feature availability in this mode, stated by the server. */
  supply_audit: boolean
  management_rpc: boolean
  /** External mode: the mint.toml fragment for the operator's cdk-mintd. */
  external_snippet?: string | null
}

export interface AppSnapshot {
  now: number
  session: { username: string; must_change_password: boolean }
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
  supply: SupplySnapshot
  circulation: CirculationPoint[]
  open_quotes: OpenQuoteSummary[]
  recent_done: Ticket[]
  units: ManagedUnit[]
  capabilities: Capability[]
  consistency: ConsistencyState
  users: UserEntry[]
  demo_password_active: boolean
  password_min_length: number
  /** Image/build version stamped at build time; "dev" outside CI images. */
  version: string
  mint_connection: MintConnectionInfo
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

function post<T>(path: string, body?: unknown) {
  return requestJson<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// ---- auth ----

export interface LoginResult {
  message: string
  /** Installer-provisioned password still active: the UI must collect a new one before the console. */
  must_change_password: boolean
  password_min_length: number
}

export function login(username: string, password: string) {
  return post<LoginResult>("/api/login", { username, password })
}

export function logout() {
  return post<{ message: string }>("/api/logout")
}

// ---- snapshot ----

export function fetchSnapshot() {
  return requestJson<AppSnapshot>("/api/app")
}

// ---- teller ----

/**
 * Resolve teller input — the last 6+ characters of a quote id typed from the
 * customer's wallet, or the full id from a scanner — to the one open quote it
 * identifies. 404 = no match, 409 = ambiguous (type more characters).
 */
export function matchQuote(code: string) {
  return post<Ticket>("/api/quotes/match", { code })
}

export function markPaid(ticketId: string, notes?: string) {
  return post<Ticket>(`/api/tickets/${encodeURIComponent(ticketId)}/mark-paid`, {
    notes: notes ?? "",
  })
}

export function markFailed(ticketId: string, notes?: string) {
  return post<Ticket>(`/api/tickets/${encodeURIComponent(ticketId)}/mark-failed`, {
    notes: notes ?? "",
  })
}

// ---- units & keysets ----

export function addUnit(input: {
  unit: string
  keyset_lifetime_days: number
  rotate_before_expiry_days: number
  input_fee_ppk: number
  amounts: string
}) {
  return post<{ message: string }>("/api/units", input) // restarts the stack
}

export function setUnitLifecycle(
  unit: string,
  lifecycle: UnitLifecycle,
  options: { forceUnverified?: boolean } = {},
) {
  return post<{ message: string }>(`/api/units/${encodeURIComponent(unit)}/lifecycle`, {
    lifecycle,
    // External mints only: retire although the mint is unreachable.
    force_unverified: options.forceUnverified ?? false,
  }) // restarts the stack
}

export function updateUnitPolicy(
  unit: string,
  policy: {
    enabled: boolean
    keyset_lifetime_days: number
    rotate_before_expiry_days: number
    input_fee_ppk: number
    amounts: string
  },
) {
  return post<{ message: string }>(`/api/units/${encodeURIComponent(unit)}/policy`, policy) // restarts
}

export function rotateKeyset(input: {
  unit: string
  amounts: string
  input_fee_ppk: number
  final_expiry: string | null
}) {
  return post<{ message: string }>("/api/keysets/rotate", input)
}

// ---- mint identity & recovery ----

export function updateIdentity(input: {
  name: string
  public_url: string
  description: string
  description_long: string
}) {
  return post<{ message: string }>("/api/settings/identity", input) // restarts the stack
}

export function revealMnemonic(password: string) {
  return post<{ mnemonic: string }>("/api/settings/mnemonic", { password })
}

// ---- mint connection ----

export function useBundledMint() {
  return post<{ message: string }>("/api/settings/mint-connection", { mode: "bundled" }) // restarts
}

export function connectExternalMint(input: {
  http_url: string
  rpc_url: string
  advertised_grpc: string
}) {
  return post<{ message: string }>("/api/settings/mint-connection", {
    mode: "external",
    ...input,
  }) // restarts the stack
}

// ---- users ----

export function createUser(username: string, password: string, passwordConfirm: string) {
  return post<UserEntry>("/api/users", {
    username,
    password,
    password_confirm: passwordConfirm,
  })
}

export function deleteUser(username: string) {
  return requestJson<{ message: string }>(`/api/users/${encodeURIComponent(username)}`, {
    method: "DELETE",
  })
}

export function changePassword(currentPassword: string, password: string, passwordConfirm: string) {
  return post<{ message: string }>("/api/me/password", {
    current_password: currentPassword,
    password,
    password_confirm: passwordConfirm,
  })
}

export function resetUserPassword(username: string, password: string, passwordConfirm: string) {
  return post<{ message: string }>(`/api/users/${encodeURIComponent(username)}/password`, {
    password,
    password_confirm: passwordConfirm,
  })
}
