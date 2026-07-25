import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  BadgeCheck,
  Banknote,
  CheckCircle2,
  CircleDot,
  Copy,
  Database,
  Gauge,
  KeyRound,
  Layers3,
  LockKeyhole,
  LogOut,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  ShieldCheck,
  WalletCards,
  XCircle,
} from "lucide-react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import {
  apiPost,
  ApiRequestError,
  AppSnapshot,
  CirculationPoint,
  KeysetEntry,
  requestJson,
  SetupDefaults,
  Ticket,
  TicketKind,
  TicketStatus,
  UnitLifecycle,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

type RouteName = "overview" | "teller" | "keysets" | "settings"

const navItems: Array<{ route: RouteName; href: string; label: string; icon: typeof Gauge }> = [
  { route: "overview", href: "/", label: "Overview", icon: Gauge },
  { route: "teller", href: "/teller", label: "Teller", icon: Banknote },
  { route: "keysets", href: "/keysets", label: "Keysets", icon: KeyRound },
  { route: "settings", href: "/settings", label: "Settings", icon: Settings },
]

function App() {
  const pathname = window.location.pathname
  if (pathname === "/login") {
    return <LoginPage />
  }
  if (pathname === "/setup") {
    return <SetupPage />
  }
  return <AuthenticatedApp />
}

function AuthenticatedApp() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [setupFallback, setSetupFallback] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const data = await requestJson<AppSnapshot>("/api/app")
      setSnapshot(data)
      setError(null)
      setSetupFallback(false)
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        window.location.href = "/login"
        return
      }
      if (err instanceof ApiRequestError && err.status === 404) {
        try {
          await requestJson<SetupDefaults>("/api/setup/defaults")
          setSetupFallback(true)
          setError(null)
          return
        } catch (_) {
          setSetupFallback(false)
        }
      }
      setError(err instanceof Error ? err.message : "Could not load the operator dashboard.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!snapshot) return
    let timer: number | undefined
    const source = new EventSource("/events")
    source.addEventListener("change", () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refresh(), 220)
    })
    return () => {
      window.clearTimeout(timer)
      source.close()
    }
  }, [refresh, snapshot])

  if (setupFallback) {
    return <SetupPage />
  }

  if (loading) {
    return <LoadingScreen />
  }

  if (!snapshot || error) {
    return (
      <CenteredSurface>
        <Alert variant="danger">{error ?? "The operator dashboard could not be loaded."}</Alert>
        <Button className="mt-4" onClick={() => void refresh()}>
          <RefreshCw />
          Retry
        </Button>
      </CenteredSurface>
    )
  }

  const route = routeFromPath(window.location.pathname)

  return (
    <AppShell snapshot={snapshot} route={route} onRefresh={refresh}>
      {route === "overview" && <OverviewPage snapshot={snapshot} />}
      {route === "teller" && <TellerPage snapshot={snapshot} onRefresh={refresh} />}
      {route === "keysets" && <KeysetsPage snapshot={snapshot} onRefresh={refresh} />}
      {route === "settings" && <SettingsPage snapshot={snapshot} />}
    </AppShell>
  )
}

function AppShell({
  snapshot,
  route,
  children,
  onRefresh,
}: {
  snapshot: AppSnapshot
  route: RouteName
  children: ReactNode
  onRefresh: () => Promise<void>
}) {
  const activeQuotes = snapshot.active_tickets.length

  async function logout() {
    await apiPost("/api/logout")
    window.location.href = "/login"
  }

  return (
    <div className="app-frame">
      <aside className="app-sidebar">
        <div className="flex items-center gap-3 px-2">
          <div className="grid size-8 place-items-center rounded-sm bg-primary text-sm font-bold text-primary-foreground">
            ◐
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Branch</div>
            <div className="truncate text-xs text-muted-foreground">{snapshot.mint.name}</div>
          </div>
        </div>

        <nav className="mt-7 grid gap-1">
          {navItems.map((item) => {
            const Icon = item.icon
            const active = item.route === route
            return (
              <a
                key={item.route}
                href={item.href}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-sm px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground",
                  active && "bg-primary-soft text-primary",
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </a>
            )
          })}
        </nav>

        <div className="mt-7 grid gap-2 rounded-md border border-border bg-surface p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Managed units</span>
            <span className="font-mono text-xs font-medium">{snapshot.units.length}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Method</span>
            <span className="font-mono text-xs">{snapshot.mint.method}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Active quotes</span>
            <Badge variant={activeQuotes ? "warning" : "success"}>{activeQuotes || "Ready"}</Badge>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 px-0">
          <Button variant="ghost" size="sm" onClick={() => void onRefresh()}>
            <RefreshCw />
            Refresh
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            <LogOut />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="app-main">
        <div className="content-width page-grid">
          {children}
        </div>
      </main>
    </div>
  )
}

function OverviewPage({ snapshot }: { snapshot: AppSnapshot }) {
  const activeKeyset = snapshot.active_keyset
  const healthItems = [
    ["Mint HTTP", snapshot.health.mint_http, Activity],
    ["Management RPC", snapshot.health.management_rpc, Database],
    ["Payment backend", snapshot.health.payment_backend, ShieldCheck],
  ] as const

  return (
    <>
      <PageHeader
        title={snapshot.mint.name}
        description={snapshot.mint.description}
        actions={
          <>
            <a href="/teller" className={buttonVariants({ variant: "primary" })}>
                <Banknote />
                Open teller
            </a>
            <a href="/keysets" className={buttonVariants()}>
                <KeyRound />
                Manage keysets
            </a>
          </>
        }
      />

      <section className="metric-grid">
        {healthItems.map(([label, item, Icon]) => (
          <MetricTile
            key={label}
            label={label}
            value={item.label}
            detail={item.detail}
            icon={<Icon className="size-4" />}
            tone={item.ok ? "success" : "danger"}
          />
        ))}
        <MetricTile
          label={`Estimated circulation · ${snapshot.mint.unit}`}
          value={formatSignedAmount(snapshot.summary.net_issued, snapshot.mint.unit)}
          detail="Completed mints minus completed melts"
          icon={<WalletCards className="size-4" />}
          tone="info"
        />
        <MetricTile
          label="Active quotes"
          value={String(snapshot.active_tickets.length)}
          detail="Waiting or pending teller work"
          icon={<CircleDot className="size-4" />}
          tone={snapshot.active_tickets.length ? "warning" : "success"}
        />
      </section>

      <section className="dashboard-grid">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Circulating ecash</CardTitle>
              <CardDescription>
                Net issued balance over settled mint and melt activity.
              </CardDescription>
            </div>
            <Badge variant="info">{snapshot.circulation.length} points</Badge>
          </CardHeader>
          <CardContent>
            <CirculationChart data={snapshot.circulation} unit={snapshot.mint.unit} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Keyset state</CardTitle>
              <CardDescription>Active signing keyset and rollover policy.</CardDescription>
            </div>
            {activeKeyset ? (
              <KeysetBadge keyset={activeKeyset} now={snapshot.now} />
            ) : (
              <Badge variant="warning">Waiting</Badge>
            )}
          </CardHeader>
          <CardContent className="detail-grid">
            {activeKeyset ? (
              <>
                <DetailRow label="Active keyset">
                  <span className="mono-chip">{activeKeyset.id}</span>
                </DetailRow>
                <DetailRow label="Final expiry">{formatExpiry(activeKeyset.final_expiry, snapshot.now)}</DetailRow>
                <DetailRow label="Input fee">
                  <span className="font-mono">{activeKeyset.input_fee_ppk} ppk</span>
                </DetailRow>
                <DetailRow label="Total keysets">{snapshot.keysets.items.length}</DetailRow>
              </>
            ) : (
              <EmptyState
                title="No active keyset yet"
                body="The rollover worker will create the first expiring keyset once management RPC is reachable."
              />
            )}
            {!snapshot.keysets.ok && (
              <Alert variant="danger">Could not read keysets: {snapshot.keysets.error}</Alert>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="two-column-grid">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Processed volume</CardTitle>
              <CardDescription>Settled activity recorded by the branch processor.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3">
            <VolumeRow
              icon={<ArrowUpRight />}
              label="Mints processed"
              count={snapshot.summary.mint_count}
              amount={formatAmount(snapshot.summary.minted_amount, snapshot.mint.unit)}
              tone="success"
            />
            <VolumeRow
              icon={<ArrowDownLeft />}
              label="Melts processed"
              count={snapshot.summary.melt_count}
              amount={formatAmount(snapshot.summary.melted_amount, snapshot.mint.unit)}
              tone="warning"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Rollover policy</CardTitle>
              <CardDescription>Configured during first-run provisioning.</CardDescription>
            </div>
            <Badge variant={snapshot.rollover.enabled ? "info" : "neutral"}>
              {snapshot.rollover.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </CardHeader>
          <CardContent className="detail-grid">
            <DetailRow label="Lifetime">{snapshot.rollover.keyset_lifetime_days} days</DetailRow>
            <DetailRow label="Rotate before expiry">
              {snapshot.rollover.rotate_before_expiry_days} days
            </DetailRow>
            <DetailRow label="Denominations">{snapshot.rollover.amounts.length} amounts</DetailRow>
            <DetailRow label="Public URL">
              <span className="font-mono text-xs break-all">{snapshot.endpoints.public_url}</span>
            </DetailRow>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Unit balances</CardTitle>
            <CardDescription>
              Per-unit activity is kept separate; values from unlike units are never summed.
            </CardDescription>
          </div>
          <Layers3 className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent className="p-0">
          <div className="table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Unit</TableHead>
                  <TableHead>Lifecycle</TableHead>
                  <TableHead>Mints</TableHead>
                  <TableHead>Melts</TableHead>
                  <TableHead>Net issued</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.unit_summaries.map((summary) => {
                  const managed = snapshot.units.find((unit) => unit.unit === summary.unit)
                  return (
                    <TableRow key={summary.unit}>
                      <TableCell className="font-mono font-medium uppercase">{summary.unit}</TableCell>
                      <TableCell>{managed ? <LifecycleBadge lifecycle={managed.lifecycle} /> : <Badge>Observed</Badge>}</TableCell>
                      <TableCell>{summary.mint_count}</TableCell>
                      <TableCell>{summary.melt_count}</TableCell>
                      <TableCell className="font-mono">{formatSignedAmount(summary.net_issued, summary.unit)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <ActivityTable title="Recent settled activity" tickets={snapshot.recent_done.slice(0, 8)} now={snapshot.now} />
    </>
  )
}

function TellerPage({ snapshot, onRefresh }: { snapshot: AppSnapshot; onRefresh: () => Promise<void> }) {
  const active = snapshot.active_tickets
  return (
    <>
      <PageHeader
        title="Teller"
        description="Create one quote offer at a time, let the customer's wallet scan and claim it, then confirm settlement after cash changes hands."
      />
      <section className="dashboard-grid">
        <QuotePanel snapshot={snapshot} active={active} onRefresh={onRefresh} />
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Current operating state</CardTitle>
              <CardDescription>Live teller constraints for this mint.</CardDescription>
            </div>
            <Badge variant={active.length ? "warning" : "success"}>{active.length ? "Busy" : "Ready"}</Badge>
          </CardHeader>
          <CardContent className="detail-grid">
            <DetailRow label="Units">
              <span className="font-mono uppercase">
                {snapshot.units.filter((unit) => unit.can_mint || unit.can_melt).map((unit) => unit.unit).join(", ") || "None"}
              </span>
            </DetailRow>
            <DetailRow label="Method">
              <span className="font-mono">{snapshot.mint.method}</span>
            </DetailRow>
            <DetailRow label="Active quotes">{active.length}</DetailRow>
            <DetailRow label="Wallet URL">
              <span className="font-mono text-xs break-all">{snapshot.endpoints.public_url}</span>
            </DetailRow>
          </CardContent>
        </Card>
      </section>

      <ActivityTable title="Recent activity" tickets={snapshot.recent_done} now={snapshot.now} showNotes />
    </>
  )
}

function QuotePanel({
  snapshot,
  active,
  onRefresh,
}: {
  snapshot: AppSnapshot
  active: Ticket[]
  onRefresh: () => Promise<void>
}) {
  if (active.length === 0) {
    return <CreateQuoteCard snapshot={snapshot} onRefresh={onRefresh} />
  }
  if (active.length > 1) {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Multiple active quotes</CardTitle>
            <CardDescription>Finish or cancel active quotes before creating another.</CardDescription>
          </div>
          <Badge variant="danger">{active.length} active</Badge>
        </CardHeader>
        <CardContent>
          <Alert variant="danger">The server detected more than one active quote.</Alert>
        </CardContent>
      </Card>
    )
  }
  return <ActiveQuoteCard ticket={active[0]} now={snapshot.now} onRefresh={onRefresh} />
}

function CreateQuoteCard({ snapshot, onRefresh }: { snapshot: AppSnapshot; onRefresh: () => Promise<void> }) {
  const [kind, setKind] = useState<TicketKind>("incoming")
  const availableUnits = snapshot.units.filter((unit) =>
    kind === "incoming" ? unit.can_mint : unit.can_melt,
  )
  const [unit, setUnit] = useState(availableUnits[0]?.unit ?? "")
  const [amount, setAmount] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!availableUnits.some((item) => item.unit === unit)) {
      setUnit(availableUnits[0]?.unit ?? "")
    }
  }, [availableUnits, unit])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost<Ticket>("/api/quotes", {
        kind: kind === "incoming" ? "mint" : "melt",
        unit,
        amount: Number(amount),
        description,
      })
      setAmount("")
      setDescription("")
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create quote.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Create quote offer</CardTitle>
          <CardDescription>
            The wallet claims the offer and creates the quote itself — no quote ID ever leaves this screen.
          </CardDescription>
        </div>
        <Badge variant="success">Ready</Badge>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label>Flow</Label>
            <div className="grid grid-cols-2 gap-2 rounded-md bg-surface-muted p-1">
              <Button
                type="button"
                variant={kind === "incoming" ? "primary" : "ghost"}
                onClick={() => setKind("incoming")}
              >
                <ArrowUpRight />
                Cash deposit
              </Button>
              <Button
                type="button"
                variant={kind === "outgoing" ? "primary" : "ghost"}
                onClick={() => setKind("outgoing")}
              >
                <ArrowDownLeft />
                Cash dispense
              </Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount">
              <Input
                type="number"
                min="1"
                step="1"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field label="Unit">
              <Select value={unit} onChange={(event) => setUnit(event.target.value)} required>
                {availableUnits.map((item) => (
                  <option key={item.unit} value={item.unit}>
                    {item.unit.toUpperCase()} · {snapshot.mint.method}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {availableUnits.length === 0 && (
            <Alert variant="warning">
              No unit currently supports this operation. Update unit lifecycle in Settings.
            </Alert>
          )}
          <Field label="Note">
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional receipt or customer reference"
            />
          </Field>
          {error && <Alert variant="danger">{error}</Alert>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" loading={busy} disabled={busy || !unit}>
              <Banknote />
              Create offer
            </Button>
            <span className="text-xs text-muted-foreground">
              One active offer at a time; offers are single-use and expire after 15 minutes.
            </span>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function ActiveQuoteCard({
  ticket,
  now,
  onRefresh,
}: {
  ticket: Ticket
  now: number
  onRefresh: () => Promise<void>
}) {
  const [notes, setNotes] = useState("")
  const [busy, setBusy] = useState<"paid" | "failed" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const copyOffer = async () => {
    if (!ticket.offer) return
    await navigator.clipboard?.writeText(ticket.offer)
  }
  const incoming = ticket.kind === "incoming"
  const offered = ticket.status === "offered"
  const waiting = ticket.status === "waiting"
  const expired = offered && ticket.expires_at != null && ticket.expires_at <= now
  const title = incoming ? "Cash deposit" : "Cash dispense"
  const subtitle = offered
    ? expired
      ? "The offer expired before a wallet claimed it. Void it and create a new one."
      : "Show the offer to the customer's wallet. It can be claimed exactly once."
    : incoming
      ? "A wallet claimed this offer. Verify, take the cash, then release the funds."
      : waiting
        ? "A wallet claimed this offer but has NOT committed funds yet."
        : "Funds are locked at the mint. Verify the payment code, then dispense cash."

  async function mutate(kind: "paid" | "failed") {
    setBusy(kind)
    setError(null)
    try {
      await apiPost<Ticket>(`/api/tickets/${encodeURIComponent(ticket.id)}/mark-${kind}`, { notes })
      setNotes("")
      setConfirmed(false)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the quote.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{subtitle}</CardDescription>
        </div>
        <StatusBadge status={ticket.status} />
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0">
            <div className="text-3xl font-semibold leading-none tracking-normal">
              {formatAmount(ticket.amount, ticket.unit)}
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <DetailBlock label="Ticket">
                <span className="mono-chip">{ticket.short_id}</span>
              </DetailBlock>
              <DetailBlock label="Created">{formatAge(ticket.created_at, now)}</DetailBlock>
              {offered && ticket.expires_at != null && (
                <DetailBlock label="Offer valid">
                  {expired ? "Expired" : `${formatCountdown(ticket.expires_at, now)} left`}
                </DetailBlock>
              )}
              {ticket.description && <DetailBlock label="Note">{ticket.description}</DetailBlock>}
            </div>
            {offered && ticket.offer && (
              <div className="mt-4 grid gap-2">
                <Label>Quote offer</Label>
                <div className="flex min-w-0 gap-2">
                  <div className="min-w-0 flex-1 rounded-sm border border-border bg-surface-muted px-3 py-2 font-mono text-xs text-muted-foreground break-all">
                    {ticket.offer}
                  </div>
                  <Button type="button" size="icon" onClick={() => void copyOffer()} aria-label="Copy quote offer">
                    <Copy />
                  </Button>
                </div>
              </div>
            )}
            {!incoming && ticket.status === "pending" && ticket.verification_code && (
              <div className="mt-4 grid gap-2">
                <Label>Payment code</Label>
                <div className="rounded-md border border-border bg-surface-muted px-4 py-3 text-center font-mono text-3xl font-semibold tracking-[0.3em]">
                  {ticket.verification_code}
                </div>
                <span className="text-xs text-muted-foreground">
                  The customer's wallet shows the same code while the payment is pending.
                </span>
              </div>
            )}
          </div>
          {offered ? (
            <div className="qr-box grid place-items-center rounded-md border border-border bg-white p-3">
              {ticket.qr_svg ? (
                <div dangerouslySetInnerHTML={{ __html: ticket.qr_svg }} />
              ) : (
                <div className="grid aspect-square w-full place-items-center rounded-sm border border-dashed border-border-strong text-sm text-muted-foreground">
                  No offer
                </div>
              )}
            </div>
          ) : (
            <div className="grid place-items-center rounded-md border border-dashed border-border-strong p-6 text-center text-sm text-muted-foreground">
              {incoming
                ? "Offer claimed — the QR is no longer needed."
                : waiting
                  ? "Waiting for the wallet to commit funds."
                  : "Compare the payment code before handing out cash."}
            </div>
          )}
        </div>

        {error && <Alert variant="danger">{error}</Alert>}

        <div className="border-t border-border pt-4">
          {offered ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="danger" loading={busy === "failed"} onClick={() => void mutate("failed")}>
                <XCircle />
                Void offer
              </Button>
              <span className="text-xs text-muted-foreground">
                Voiding an unclaimed offer is always safe — no wallet holds a quote for it.
              </span>
            </div>
          ) : waiting ? (
            <div className="grid gap-3">
              <Alert variant="danger">
                Do not pay out. The wallet created a quote but has not committed funds. This card updates
                automatically once funds are locked.
              </Alert>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" loading={busy === "failed"} onClick={() => void mutate("failed")}>
                  <XCircle />
                  Cancel quote
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  {incoming
                    ? "The customer's wallet shows this claimed deposit (matching amount and mint) and the cash is on the counter."
                    : "The payment code above matches the code in the customer's wallet."}
                </span>
              </label>
              <div className="settlement-grid">
                <Input
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Receipt note (optional)"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="success"
                    loading={busy === "paid"}
                    disabled={!confirmed || busy !== null}
                    onClick={() => void mutate("paid")}
                  >
                    <CheckCircle2 />
                    {incoming ? "Cash received — release funds" : "Cash dispensed — confirm"}
                  </Button>
                  <Button variant="danger" loading={busy === "failed"} onClick={() => void mutate("failed")}>
                    <XCircle />
                    {incoming ? "Void" : "Mark failed"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function KeysetsPage({ snapshot, onRefresh }: { snapshot: AppSnapshot; onRefresh: () => Promise<void> }) {
  const rotatableUnits = snapshot.units.filter((item) => item.lifecycle === "active")
  const [unit, setUnit] = useState(rotatableUnits[0]?.unit ?? "")
  const selectedUnit = snapshot.units.find((item) => item.unit === unit)
  const [amounts, setAmounts] = useState(
    selectedUnit?.rollover.amounts.join(",") ?? snapshot.default_amounts.join(","),
  )
  const [fee, setFee] = useState(String(selectedUnit?.rollover.input_fee_ppk ?? 0))
  const [finalExpiry, setFinalExpiry] = useState(
    selectedUnit
      ? String(snapshot.now + selectedUnit.rollover.keyset_lifetime_days * 86_400)
      : "",
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function chooseUnit(nextUnit: string) {
    setUnit(nextUnit)
    const managed = snapshot.units.find((item) => item.unit === nextUnit)
    if (!managed) return
    setAmounts(managed.rollover.amounts.join(","))
    setFee(String(managed.rollover.input_fee_ppk))
    setFinalExpiry(String(snapshot.now + managed.rollover.keyset_lifetime_days * 86_400))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost("/api/keysets/rotate", {
        unit,
        amounts,
        input_fee_ppk: fee === "" ? null : Number(fee),
        final_expiry: finalExpiry.trim() || null,
      })
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rotate keyset.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Keysets"
        description="Active is the keyset the mint signs new ecash with. Expiry is enforced by the mint once final_expiry passes."
      />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Keyset inventory</CardTitle>
            <CardDescription>Current keysets reported by the mint HTTP API.</CardDescription>
          </div>
          <Badge>{snapshot.keysets.items.length} total</Badge>
        </CardHeader>
        <CardContent className="p-0">
          {!snapshot.keysets.ok ? (
            <div className="p-5">
              <Alert variant="danger">Could not read keysets: {snapshot.keysets.error}</Alert>
            </div>
          ) : snapshot.keysets.items.length === 0 ? (
            <EmptyState title="No keysets yet" body="Rotate one below once management RPC is reachable." />
          ) : (
            <div className="table-scroll">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Keyset ID</TableHead>
                    <TableHead>Unit</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Final expiry</TableHead>
                    <TableHead>Fee ppk</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {snapshot.keysets.items.map((keyset) => (
                    <TableRow key={keyset.id}>
                      <TableCell>
                        <span className="mono-chip">{keyset.id}</span>
                      </TableCell>
                      <TableCell className="font-mono uppercase">{keyset.unit}</TableCell>
                      <TableCell>
                        <KeysetBadge keyset={keyset} now={snapshot.now} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatExpiry(keyset.final_expiry, snapshot.now)}
                      </TableCell>
                      <TableCell className="font-mono">{keyset.input_fee_ppk}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Rotate to a new active keyset</CardTitle>
            <CardDescription>
              The new keyset becomes active for newly issued ecash. Previous keysets verify until their baked-in expiry passes.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Unit">
                <Select value={unit} onChange={(event) => chooseUnit(event.target.value)} required>
                  {rotatableUnits.map((item) => (
                    <option key={item.unit} value={item.unit}>
                      {item.unit.toUpperCase()}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Input fee (ppk)">
                <Input type="number" min="0" value={fee} readOnly />
              </Field>
            </div>
            <Field label="Amounts" help="Inherited from the persisted unit policy so restarts cannot rotate back to a conflicting keyset.">
              <Input value={amounts} readOnly />
            </Field>
            <Field
              label="Final expiry · unix seconds"
              help="Immutable once created. Managed keysets require a future expiry so the unit can eventually be retired."
            >
              <Input
                type="number"
                min="0"
                value={finalExpiry}
                required
                onChange={(event) => setFinalExpiry(event.target.value)}
              />
            </Field>
            {error && <Alert variant="danger">{error}</Alert>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" loading={busy} disabled={busy || !unit}>
                <RotateCw />
                Rotate keyset
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  )
}

function SettingsPage({ snapshot }: { snapshot: AppSnapshot }) {
  const unitNames = Array.from(
    new Set([...snapshot.units.map((unit) => unit.unit), ...snapshot.capabilities.map((pair) => pair.unit)]),
  )
  const [selectedName, setSelectedName] = useState(unitNames[0] ?? "")
  const [adding, setAdding] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = snapshot.units.find((unit) => unit.unit === selectedName)
  const selectedCapabilities = snapshot.capabilities.filter((pair) => pair.unit === selectedName)
  const selectedKeysets = snapshot.keysets.items.filter((keyset) => keyset.unit === selectedName)
  const defaults = snapshot.units[0]?.rollover ?? snapshot.rollover
  const [newUnit, setNewUnit] = useState("")
  const [newLifetime, setNewLifetime] = useState(String(defaults.keyset_lifetime_days))
  const [newLeadTime, setNewLeadTime] = useState(String(defaults.rotate_before_expiry_days))
  const [newFee, setNewFee] = useState(String(defaults.input_fee_ppk))
  const [newAmounts, setNewAmounts] = useState(defaults.amounts.join(","))
  const [identity, setIdentity] = useState({
    name: snapshot.mint.name,
    description: snapshot.mint.description,
    description_long: snapshot.mint.description_long,
    public_url: snapshot.endpoints.public_url,
  })

  function expectRestart() {
    setRestarting(true)
    window.setTimeout(() => window.location.reload(), 3200)
  }

  async function changeLifecycle(lifecycle: UnitLifecycle) {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      await apiPost(`/api/units/${encodeURIComponent(selected.unit)}/lifecycle`, { lifecycle })
      expectRestart()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update unit lifecycle.")
    } finally {
      setBusy(false)
    }
  }

  async function addUnit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost("/api/units", {
        unit: newUnit,
        keyset_lifetime_days: Number(newLifetime),
        rotate_before_expiry_days: Number(newLeadTime),
        input_fee_ppk: Number(newFee),
        amounts: newAmounts,
      })
      expectRestart()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add unit.")
    } finally {
      setBusy(false)
    }
  }

  async function updateIdentity(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost("/api/settings/identity", identity)
      expectRestart()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update mint identity.")
    } finally {
      setBusy(false)
    }
  }

  if (restarting) {
    return (
      <CenteredSurface>
        <div className="grid max-w-[520px] justify-items-center gap-3 text-center">
          <RefreshCw className="size-7 animate-spin text-primary" />
          <h1 className="m-0 text-xl font-semibold">Applying mint configuration</h1>
          <p className="m-0 text-sm text-muted-foreground">
            The processor and mint are restarting together. This page will reconnect automatically.
          </p>
        </div>
      </CenteredSurface>
    )
  }

  return (
    <>
      <PageHeader
        title="Units & methods"
        description="Review the mint's complete advertised capability space and migrate the branch-managed units safely."
        actions={
          <Button variant="primary" onClick={() => setAdding((value) => !value)}>
            <Plus />
            Add unit
          </Button>
        }
      />

      {!snapshot.consistency.ok && (
        <Alert variant="danger">
          <strong className="font-semibold">Configuration is not yet consistent.</strong>
          <ul className="mb-0 mt-2 pl-5">
            {snapshot.consistency.issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </Alert>
      )}

      {adding && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Add a branch unit</CardTitle>
              <CardDescription>
                This creates a new signing keyset and advertises branch mint and melt support after restart.
              </CardDescription>
            </div>
            <Badge variant="info">Migration</Badge>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4" onSubmit={addUnit}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Unit code">
                  <Input
                    value={newUnit}
                    pattern="[a-z0-9_-]+"
                    placeholder="usd"
                    onChange={(event) => setNewUnit(event.target.value.toLowerCase())}
                    required
                    autoFocus
                  />
                </Field>
                <Field label="Keyset lifetime · days">
                  <Input type="number" min="2" value={newLifetime} onChange={(event) => setNewLifetime(event.target.value)} required />
                </Field>
                <Field label="Rotate before · days">
                  <Input type="number" min="1" value={newLeadTime} onChange={(event) => setNewLeadTime(event.target.value)} required />
                </Field>
                <Field label="Input fee · ppk">
                  <Input type="number" min="0" value={newFee} onChange={(event) => setNewFee(event.target.value)} required />
                </Field>
              </div>
              <Field label="Denominations" help="Comma-separated positive amounts used by the first and future keysets.">
                <Input value={newAmounts} onChange={(event) => setNewAmounts(event.target.value)} required />
              </Field>
              {error && <Alert variant="danger">{error}</Alert>}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" loading={busy} disabled={busy}>
                  <Plus />
                  Add active unit
                </Button>
                <Button type="button" onClick={() => setAdding(false)}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <section className="unit-workspace">
        <Card className="unit-master-card">
          <CardHeader>
            <div>
              <CardTitle>Units</CardTitle>
              <CardDescription>{unitNames.length} discovered</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="unit-master-list">
            {unitNames.map((unitName) => {
              const managed = snapshot.units.find((unit) => unit.unit === unitName)
              const selectedRow = unitName === selectedName
              return (
                <button
                  key={unitName}
                  type="button"
                  className={cn("unit-master-button", selectedRow && "is-selected")}
                  onClick={() => setSelectedName(unitName)}
                >
                  <span className="grid min-w-0 gap-1 text-left">
                    <span className="font-mono text-sm font-semibold uppercase">{unitName}</span>
                    <span className="text-xs text-muted-foreground">
                      {managed ? `${managed.keyset_count} keyset${managed.keyset_count === 1 ? "" : "s"}` : "Observed only"}
                    </span>
                  </span>
                  {managed ? <LifecycleBadge lifecycle={managed.lifecycle} /> : <Badge>External</Badge>}
                </button>
              )
            })}
          </CardContent>
        </Card>

        <div className="grid min-w-0 gap-4">
          <Card>
            <CardHeader>
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <CardTitle className="font-mono uppercase">{selectedName || "No unit"}</CardTitle>
                  {selected ? <LifecycleBadge lifecycle={selected.lifecycle} /> : <Badge>Observed only</Badge>}
                </div>
                <CardDescription>
                  {selected
                    ? `Managed by the ${snapshot.mint.method} teller workflow.`
                    : "Advertised by the mint but outside the teller workflow; shown read-only."}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="detail-grid">
              <DetailRow label="Mint operations">
                <CapabilityBadge enabled={selectedCapabilities.some((pair) => pair.mint)} label="Mint" />
              </DetailRow>
              <DetailRow label="Melt operations">
                <CapabilityBadge enabled={selectedCapabilities.some((pair) => pair.melt)} label="Melt" />
              </DetailRow>
              <DetailRow label="Active keyset">
                {selected?.active_keyset
                  ? <span className="mono-chip">{selected.active_keyset.id}</span>
                  : <span className="text-muted-foreground">None reported</span>}
              </DetailRow>
              <DetailRow label="Keyset inventory">{selectedKeysets.length}</DetailRow>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Method capabilities</CardTitle>
                <CardDescription>Protocol-visible NUT-04 mint and NUT-05 melt pairs.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {selectedCapabilities.length === 0 ? (
                <EmptyState title="No advertised methods" body="Retired units intentionally have no active payment methods." />
              ) : (
                <div className="table-scroll">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Method</TableHead>
                        <TableHead>Ownership</TableHead>
                        <TableHead>Mint</TableHead>
                        <TableHead>Melt</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedCapabilities.map((pair) => (
                        <TableRow key={`${pair.unit}:${pair.method}`}>
                          <TableCell className="font-mono">{pair.method}</TableCell>
                          <TableCell>{pair.managed ? <Badge variant="info">Branch managed</Badge> : <Badge>Read-only</Badge>}</TableCell>
                          <TableCell><CapabilityBadge enabled={pair.mint} label={pair.mint ? "Enabled" : "Off"} /></TableCell>
                          <TableCell><CapabilityBadge enabled={pair.melt} label={pair.melt ? "Enabled" : "Off"} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {selected && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Lifecycle migration</CardTitle>
                  <CardDescription>
                    Lifecycle changes update request handling, advertised methods, and mint configuration together.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="grid gap-4">
                {selected.lifecycle === "active" && (
                  <>
                    <Alert variant="warning">
                      Redemption only removes this unit from mint operations. Existing ecash can still be melted until every keyset reaches final expiry.
                    </Alert>
                    <Button className="justify-self-start" variant="danger" loading={busy} onClick={() => void changeLifecycle("redemption_only")}>
                      Stop issuing · keep redemptions
                    </Button>
                  </>
                )}
                {selected.lifecycle === "redemption_only" && (
                  <>
                    <Alert variant="neutral">
                      No new ecash is issued. Melts remain available so holders can redeem outstanding value. Retirement is blocked while any keyset can still be valid.
                    </Alert>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="primary" loading={busy} onClick={() => void changeLifecycle("active")}>Resume issuing</Button>
                      <Button variant="danger" loading={busy} onClick={() => void changeLifecycle("retired")}>Retire after expiry</Button>
                    </div>
                  </>
                )}
                {selected.lifecycle === "retired" && (
                  <Alert variant="neutral">
                    This unit has no mint or melt payment method. Historical keysets stay visible for protocol records.
                  </Alert>
                )}
                {error && <Alert variant="danger">{error}</Alert>}
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Mint identity</CardTitle>
            <CardDescription>Wallet-facing metadata can change; the recovery seed remains immutable.</CardDescription>
          </div>
          <Badge variant="success">Seed protected</Badge>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={updateIdentity}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Mint name">
                <Input value={identity.name} onChange={(event) => setIdentity({ ...identity, name: event.target.value })} required />
              </Field>
              <Field label="Wallet-facing URL">
                <Input type="url" value={identity.public_url} onChange={(event) => setIdentity({ ...identity, public_url: event.target.value })} required />
              </Field>
            </div>
            <Field label="Short description">
              <Input value={identity.description} onChange={(event) => setIdentity({ ...identity, description: event.target.value })} required />
            </Field>
            <Field label="Long description">
              <Textarea rows={3} value={identity.description_long} onChange={(event) => setIdentity({ ...identity, description_long: event.target.value })} />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" loading={busy} disabled={busy}>Save identity</Button>
              <span className="text-xs text-muted-foreground">
                Recovery seed fingerprint is stored and verified on startup; the seed cannot be edited here.
              </span>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  )
}

function LifecycleBadge({ lifecycle }: { lifecycle: UnitLifecycle }) {
  if (lifecycle === "active") return <Badge variant="success">Active</Badge>
  if (lifecycle === "redemption_only") return <Badge variant="warning">Redemption only</Badge>
  return <Badge>Retired</Badge>
}

function CapabilityBadge({ enabled, label }: { enabled: boolean; label: string }) {
  return <Badge variant={enabled ? "success" : "neutral"}>{label}</Badge>
}

function LoginPage() {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost("/api/login", { password })
      window.location.href = "/"
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <CenteredSurface>
      <div className="w-full max-w-[390px] rounded-md border border-border bg-surface p-7 shadow-[var(--shadow-low)]">
        <div className="grid justify-items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-sm bg-primary text-lg font-bold text-primary-foreground">
            ◐
          </div>
          <div>
            <h1 className="m-0 text-lg font-semibold">Operator sign-in</h1>
            <p className="mt-1 text-sm text-muted-foreground">Enter the operator password to continue.</p>
          </div>
        </div>
        <form className="mt-6 grid gap-4" onSubmit={submit}>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              autoFocus
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {error && <Alert variant="danger">{error}</Alert>}
          <Button type="submit" variant="primary" loading={busy} disabled={busy}>
            <LockKeyhole />
            Sign in
          </Button>
        </form>
      </div>
    </CenteredSurface>
  )
}

function SetupPage() {
  const [defaults, setDefaults] = useState<SetupDefaults | null>(null)
  const [form, setForm] = useState<SetupDefaults | null>(null)
  const [password, setPassword] = useState("")
  const [passwordConfirm, setPasswordConfirm] = useState("")
  const [backupConfirmed, setBackupConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ app_config_path: string; mint_config_path: string } | null>(null)
  const [setupUnavailable, setSetupUnavailable] = useState(false)

  useEffect(() => {
    requestJson<SetupDefaults>("/api/setup/defaults")
      .then((data) => {
        setDefaults(data)
        setForm(data)
      })
      .catch(() => setSetupUnavailable(true))
  }, [])

  const rules = useMemo(() => {
    const min = defaults?.password_min_length ?? 12
    return {
      length: [...password].length >= min,
      letter: /\p{L}/u.test(password),
      number: /\d/.test(password),
      symbol: /[^\p{L}\p{N}\s]/u.test(password),
      match: password.length > 0 && password === passwordConfirm,
    }
  }, [defaults?.password_min_length, password, passwordConfirm])

  const validSetupSlug = (value: string) => /^[a-z0-9_-]+$/.test(value)
  const validHttpUrl = (value: string) => {
    try {
      const url = new URL(value.trim())
      return url.protocol === "http:" || url.protocol === "https:"
    } catch (_) {
      return false
    }
  }
  const validAmounts = (value: string) => {
    const parts = value.split(",").map((part) => part.trim()).filter(Boolean)
    return parts.length > 0 && parts.every((part) => /^\d+$/.test(part) && BigInt(part) > 0n)
  }

  const identityReady =
    !!form && !!form.name.trim() && !!form.description.trim() && validHttpUrl(form.public_url)
  const unitReady =
    !!form && validSetupSlug(form.unit.trim()) && validSetupSlug(form.method.trim())
  const accessReady = Object.values(rules).every(Boolean)
  const recoveryReady = !!form?.mnemonic.trim() && backupConfirmed
  const keysetReady =
    !!form &&
    form.keyset_lifetime_days >= 2 &&
    form.rotate_before_expiry_days >= 1 &&
    form.rotate_before_expiry_days < form.keyset_lifetime_days &&
    form.input_fee_ppk >= 0 &&
    validAmounts(form.amounts)
  const valid = identityReady && unitReady && accessReady && recoveryReady && keysetReady
  const completedSections = [identityReady, unitReady, accessReady, recoveryReady, keysetReady].filter(Boolean).length

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!form || !valid) return
    setBusy(true)
    setError(null)
    try {
      const response = await apiPost<{ app_config_path: string; mint_config_path: string }>("/api/setup", {
        ...form,
        password,
        password_confirm: passwordConfirm,
        rollover_enabled: form.rollover_enabled ? "yes" : null,
        backup_confirmed: backupConfirmed ? "yes" : null,
      })
      setSaved(response)
      window.setTimeout(() => {
        window.location.href = "/"
      }, 3600)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save setup.")
    } finally {
      setBusy(false)
    }
  }

  if (setupUnavailable) {
    return (
      <CenteredSurface>
        <Alert variant="neutral">Setup is already complete. Open the operator dashboard instead.</Alert>
        <a href="/" className="mt-4 inline-flex">
          <Button>Back to dashboard</Button>
        </a>
      </CenteredSurface>
    )
  }

  if (!form || !defaults) {
    return <LoadingScreen />
  }

  if (saved) {
    return (
      <CenteredSurface>
        <div className="w-full max-w-[620px] rounded-md border border-border bg-surface p-7 shadow-[var(--shadow-low)]">
          <div className="flex items-center gap-3">
            <BadgeCheck className="size-8 text-success" />
            <div>
              <h1 className="m-0 text-xl font-semibold">Mint configuration saved</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                The service is restarting with the generated mint configuration.
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-3">
            <DetailRow label="Lifecycle config">
              <span className="font-mono text-xs break-all">{saved.app_config_path}</span>
            </DetailRow>
            <DetailRow label="Mint config">
              <span className="font-mono text-xs break-all">{saved.mint_config_path}</span>
            </DetailRow>
          </div>
        </div>
      </CenteredSurface>
    )
  }

  return (
    <div className="setup-frame">
      <aside className="setup-sidebar">
        <div className="flex items-center gap-3 px-2">
          <div className="grid size-8 place-items-center rounded-sm bg-primary text-sm font-bold text-primary-foreground">
            ◐
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">Branch</div>
            <div className="text-xs text-muted-foreground">Mint management</div>
          </div>
        </div>

        <div className="mt-8 px-2">
          <Badge variant="info">First run</Badge>
          <h2 className="mt-3 text-[15px] font-semibold">Provisioning checklist</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Review every section before the mint writes its first keyset.
          </p>
        </div>

        <nav className="setup-progress" aria-label="Setup sections">
          <SetupProgressItem href="#setup-identity" label="Mint identity" complete={identityReady} />
          <SetupProgressItem href="#setup-unit" label="Unit and method" complete={unitReady} />
          <SetupProgressItem href="#setup-access" label="Operator access" complete={accessReady} />
          <SetupProgressItem href="#setup-recovery" label="Recovery phrase" complete={recoveryReady} />
          <SetupProgressItem href="#setup-keysets" label="Keyset policy" complete={keysetReady} />
        </nav>

        <div className="setup-sidebar-note">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">Setup progress</span>
            <span className="font-mono text-xs font-medium">{completedSections}/5</span>
          </div>
          <div className="setup-progress-track" aria-hidden="true">
            <span style={{ width: `${completedSections * 20}%` }} />
          </div>
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            The recovery phrase and existing unit codes cannot be replaced after provisioning.
          </p>
        </div>
      </aside>

      <main className="setup-main">
        <form className="setup-form" onSubmit={submit}>
          <PageHeader
            title="Set up your custom unit mint"
            description="Configure the operator-facing identity, first branch unit, recovery controls, and keyset policy. The mint starts automatically after review."
            actions={<Badge variant={valid ? "success" : "neutral"}>{valid ? "Ready" : "Draft"}</Badge>}
          />

          <Card id="setup-identity" className="scroll-mt-6">
            <SetupCardHeader
              icon={<WalletCards />}
              title="Mint identity"
              description="These details are published to wallets and remain editable from Settings."
              complete={identityReady}
            />
            <CardContent className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Mint name" htmlFor="setup-name">
                  <Input
                    id="setup-name"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    required
                  />
                </Field>
                <Field label="Wallet-facing URL" help="Use the URL wallets will scan or paste." htmlFor="setup-url">
                  <Input
                    id="setup-url"
                    type="url"
                    value={form.public_url}
                    onChange={(event) => setForm({ ...form, public_url: event.target.value })}
                    required
                  />
                </Field>
              </div>
              <Field label="Short description" htmlFor="setup-description">
                <Input
                  id="setup-description"
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                  required
                />
              </Field>
              <Field label="Long description" htmlFor="setup-description-long">
                <Textarea
                  id="setup-description-long"
                  rows={3}
                  value={form.description_long}
                  onChange={(event) => setForm({ ...form, description_long: event.target.value })}
                />
              </Field>
            </CardContent>
          </Card>

          <Card id="setup-unit" className="scroll-mt-6">
            <SetupCardHeader
              icon={<Layers3 />}
              title="Unit and payment method"
              description="Create the first method-unit pair for the branch teller workflow."
              complete={unitReady}
            />
            <CardContent className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="Custom unit"
                  help="Lowercase unit code. It cannot be renamed; additional units can be added later."
                  htmlFor="setup-unit-code"
                >
                  <Input
                    id="setup-unit-code"
                    className="font-mono"
                    value={form.unit}
                    pattern="[a-z0-9_-]+"
                    onChange={(event) => setForm({ ...form, unit: event.target.value })}
                    required
                  />
                </Field>
                <Field
                  label="Payment method"
                  help="The managed teller workflow supports the branch method."
                  htmlFor="setup-method"
                >
                  <Input id="setup-method" className="font-mono" value={form.method} readOnly />
                </Field>
              </div>
              <Alert variant="neutral">
                Unit additions and lifecycle changes use the migration workflow after setup. Existing unit codes are never
                rewritten in place.
              </Alert>
            </CardContent>
          </Card>

          <Card id="setup-access" className="scroll-mt-6">
            <SetupCardHeader
              icon={<LockKeyhole />}
              title="Operator access"
              description="Protect the browser management interface with a dedicated operator password."
              complete={accessReady}
            />
            <CardContent className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Operator password" htmlFor="setup-password">
                  <Input
                    id="setup-password"
                    type="password"
                    minLength={defaults.password_min_length}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </Field>
                <Field label="Confirm password" htmlFor="setup-password-confirm">
                  <Input
                    id="setup-password-confirm"
                    type="password"
                    minLength={defaults.password_min_length}
                    value={passwordConfirm}
                    onChange={(event) => setPasswordConfirm(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2" aria-label="Password requirements">
                {[
                  ["length", `At least ${defaults.password_min_length} characters`],
                  ["letter", "Contains a letter"],
                  ["number", "Contains a number"],
                  ["symbol", "Contains a symbol"],
                  ["match", "Passwords match"],
                ].map(([key, label]) => (
                  <Badge key={key} variant={rules[key as keyof typeof rules] ? "success" : "neutral"}>
                    {label}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card id="setup-recovery" className="scroll-mt-6">
            <SetupCardHeader
              icon={<ShieldCheck />}
              title="Recovery phrase"
              description="This seed deterministically restores the mint's signing keys and is immutable."
              complete={recoveryReady}
            />
            <CardContent className="grid gap-4">
              <Field
                label="Mint seed phrase"
                help="It restores Cashu keysets. It does not control bitcoin funds in this processor."
                htmlFor="setup-mnemonic"
              >
                <Textarea
                  id="setup-mnemonic"
                  className="font-mono text-xs"
                  rows={4}
                  value={form.mnemonic}
                  onChange={(event) => setForm({ ...form, mnemonic: event.target.value })}
                  spellCheck={false}
                  required
                />
              </Field>
              <label className="setup-checkbox">
                <input
                  className="mt-0.5 accent-primary"
                  type="checkbox"
                  checked={backupConfirmed}
                  onChange={(event) => setBackupConfirmed(event.target.checked)}
                  required
                />
                <span>
                  <strong className="block font-medium text-foreground">Recovery copy saved</strong>
                  I understand this phrase is required to recover the mint's signing keys.
                </span>
              </label>
            </CardContent>
          </Card>

          <Card id="setup-keysets" className="scroll-mt-6">
            <SetupCardHeader
              icon={<KeyRound />}
              title="Keyset policy"
              description="Define how the first unit creates and rotates its signing keysets."
              complete={keysetReady}
            />
            <CardContent className="grid gap-4">
              <label className="setup-checkbox">
                <input
                  className="mt-0.5 accent-primary"
                  type="checkbox"
                  checked={form.rollover_enabled}
                  onChange={(event) => setForm({ ...form, rollover_enabled: event.target.checked })}
                />
                <span>
                  <strong className="block font-medium text-foreground">Automatic rollover</strong>
                  Rotate to a new keyset before the active keyset reaches final expiry.
                </span>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Keyset lifetime · days" htmlFor="setup-lifetime">
                  <Input
                    id="setup-lifetime"
                    type="number"
                    min="2"
                    value={form.keyset_lifetime_days}
                    onChange={(event) => setForm({ ...form, keyset_lifetime_days: Number(event.target.value) })}
                    required
                  />
                </Field>
                <Field label="Rotate before expiry · days" htmlFor="setup-lead-time">
                  <Input
                    id="setup-lead-time"
                    type="number"
                    min="1"
                    value={form.rotate_before_expiry_days}
                    onChange={(event) => setForm({ ...form, rotate_before_expiry_days: Number(event.target.value) })}
                    required
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Input fee (ppk)" htmlFor="setup-fee">
                  <Input
                    id="setup-fee"
                    type="number"
                    min="0"
                    value={form.input_fee_ppk}
                    onChange={(event) => setForm({ ...form, input_fee_ppk: Number(event.target.value) })}
                    required
                  />
                </Field>
                <Field label="Denominations" help="Comma-separated positive values." htmlFor="setup-amounts">
                  <Input
                    id="setup-amounts"
                    className="font-mono text-xs"
                    value={form.amounts}
                    onChange={(event) => setForm({ ...form, amounts: event.target.value })}
                    required
                  />
                </Field>
              </div>
            </CardContent>
          </Card>

          {error && <Alert variant="danger">{error}</Alert>}
          <div className="setup-action-bar">
            <div className="min-w-0">
              <div className={cn("text-sm font-medium", valid ? "text-success" : "text-foreground")}>
                {valid ? "Configuration ready" : `${completedSections} of 5 sections complete`}
              </div>
              <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Provisioning writes the configuration and starts the mint.
              </div>
            </div>
            <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!valid || busy}>
              <ShieldCheck />
              Provision mint
            </Button>
          </div>
        </form>
      </main>
    </div>
  )
}

function CirculationChart({ data, unit }: { data: CirculationPoint[]; unit: string }) {
  const chartData = data.map((point) => ({
    ...point,
    label: new Date(point.ts * 1000).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }),
  }))

  if (chartData.length === 0) {
    return <EmptyState title="No circulation history yet" body="Settled mints and melts will build this graph over time." />
  }

  return (
    <div className="h-[318px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ left: 2, right: 12, top: 14, bottom: 0 }}>
          <defs>
            <linearGradient id="circulationFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--chart-fill)" stopOpacity={1} />
              <stop offset="95%" stopColor="var(--chart-fill)" stopOpacity={0.08} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} />
          <YAxis
            width={70}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => compactNumber(Number(value))}
          />
          <Tooltip content={<ChartTooltip unit={unit} />} />
          <Area
            type="monotone"
            dataKey="circulation"
            stroke="var(--chart-line)"
            strokeWidth={2}
            fill="url(#circulationFill)"
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function ChartTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean
  payload?: Array<{ payload: CirculationPoint }>
  unit: string
}) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload as CirculationPoint
  return (
    <div className="rounded-sm border border-border bg-surface px-3 py-2 shadow-[var(--shadow-low)]">
      <div className="text-xs font-medium text-muted-foreground">{formatDateTime(point.ts)}</div>
      <div className="mt-1 text-sm font-semibold">{formatSignedAmount(point.circulation, unit)}</div>
      <div className="text-xs text-muted-foreground">
        Delta {point.delta > 0 ? "+" : ""}
        {formatAmount(point.delta, unit)}
      </div>
    </div>
  )
}

function ActivityTable({
  title,
  tickets,
  now,
  showNotes,
}: {
  title: string
  tickets: Ticket[]
  now: number
  showNotes?: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <span className="text-sm text-muted-foreground">{tickets.length} rows</span>
      </CardHeader>
      <CardContent className="p-0">
        {tickets.length === 0 ? (
          <EmptyState title="No settled operations yet" body="Completed mints and melts will appear here." />
        ) : (
          <div className="table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ticket</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>When</TableHead>
                  {showNotes && <TableHead>Notes</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.map((ticket) => (
                  <TableRow key={ticket.id}>
                    <TableCell>
                      <span className="mono-chip">{ticket.short_id}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{ticket.kind_label}</TableCell>
                    <TableCell className="font-medium">{formatAmount(ticket.amount, ticket.unit)}</TableCell>
                    <TableCell>
                      <StatusBadge status={ticket.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatAge(ticket.paid_at ?? ticket.created_at, now)}
                    </TableCell>
                    {showNotes && <TableCell className="text-muted-foreground">{ticket.notes ?? "-"}</TableCell>}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 max-w-[76ch]">
        <h1 className="m-0 text-2xl font-semibold leading-tight tracking-normal text-foreground">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  )
}

function MetricTile({
  label,
  value,
  detail,
  icon,
  tone,
}: {
  label: string
  value: string
  detail: string
  icon: ReactNode
  tone: "info" | "success" | "warning" | "danger"
}) {
  const toneClass = {
    info: "bg-primary-soft text-primary",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
  }[tone]
  return (
    <div className="rounded-md border border-border bg-surface p-4 shadow-[var(--shadow-low)]">
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className={cn("grid size-7 place-items-center rounded-sm", toneClass)}>{icon}</span>
      </div>
      <div className="mt-3 break-words text-xl font-semibold leading-tight">{value}</div>
      <div className="mt-1 break-words text-xs leading-5 text-muted-foreground">{detail}</div>
    </div>
  )
}

function VolumeRow({
  icon,
  label,
  count,
  amount,
  tone,
}: {
  icon: ReactNode
  label: string
  count: number
  amount: string
  tone: "success" | "warning"
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface-raised px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className={cn("grid size-8 place-items-center rounded-sm", tone === "success" ? "bg-success-soft text-success" : "bg-warning-soft text-warning")}>
          {icon}
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted-foreground">{count} completed</div>
        </div>
      </div>
      <div className="font-mono text-sm font-medium">{amount}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: TicketStatus }) {
  const variant =
    status === "paid" ? "success" : status === "failed" ? "danger" : status === "pending" ? "warning" : "info"
  const label = status[0].toUpperCase() + status.slice(1)
  return <Badge variant={variant}>{label}</Badge>
}

function KeysetBadge({ keyset, now }: { keyset: KeysetEntry; now: number }) {
  const expired = keyset.final_expiry != null && keyset.final_expiry <= now
  if (expired) return <Badge variant="danger">Expired</Badge>
  if (keyset.active) return <Badge variant="info">Active</Badge>
  return <Badge>Inactive</Badge>
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-row">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0 text-sm font-medium">{children}</div>
    </div>
  )
}

function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  )
}

function Field({
  label,
  help,
  htmlFor,
  children,
}: {
  label: string
  help?: string
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help && <p className="m-0 text-xs leading-5 text-muted-foreground">{help}</p>}
    </div>
  )
}

function SetupProgressItem({
  href,
  label,
  complete,
}: {
  href: string
  label: string
  complete: boolean
}) {
  const Icon = complete ? CheckCircle2 : CircleDot
  return (
    <a className={cn("setup-progress-item", complete && "is-complete")} href={href}>
      <Icon className="size-4 shrink-0" />
      <span>{label}</span>
      <span className="ml-auto text-xs">{complete ? "Done" : "Required"}</span>
    </a>
  )
}

function SetupCardHeader({
  icon,
  title,
  description,
  complete,
}: {
  icon: ReactNode
  title: string
  description: string
  complete: boolean
}) {
  return (
    <CardHeader className="setup-card-header">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-surface-muted text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
      </div>
      <Badge variant={complete ? "success" : "neutral"}>{complete ? "Complete" : "Required"}</Badge>
    </CardHeader>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid justify-items-center gap-1 px-5 py-9 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="max-w-[58ch] text-sm text-muted-foreground">{body}</div>
    </div>
  )
}

function LoadingScreen() {
  return (
    <CenteredSurface>
      <div className="grid w-full max-w-[760px] gap-3">
        <Skeleton className="h-12" />
        <Skeleton className="h-44" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      </div>
    </CenteredSurface>
  )
}

function CenteredSurface({ children }: { children: ReactNode }) {
  return <main className="grid min-h-screen place-items-center px-4 py-10">{children}</main>
}

function routeFromPath(path: string): RouteName {
  if (path.startsWith("/teller")) return "teller"
  if (path.startsWith("/keysets")) return "keysets"
  if (path.startsWith("/settings")) return "settings"
  return "overview"
}

function formatAmount(amount: number, unit: string) {
  return `${new Intl.NumberFormat().format(amount)} ${unit.toUpperCase()}`
}

function formatSignedAmount(amount: number, unit: string) {
  if (amount < 0) return `-${formatAmount(Math.abs(amount), unit)}`
  return formatAmount(amount, unit)
}

function compactNumber(amount: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(amount)
}

function formatAge(then: number, now: number) {
  if (then >= now) return "just now"
  const seconds = now - then
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

function formatExpiry(expiry: number | null | undefined, now: number) {
  if (!expiry) return "-"
  if (expiry <= now) return `expired ${formatAge(expiry, now)}`
  const delta = expiry - now
  if (delta < 3600) return `in ${Math.floor(delta / 60)}m`
  if (delta < 86_400) return `in ${Math.floor(delta / 3600)}h`
  return `in ${Math.floor(delta / 86_400)}d`
}

function formatCountdown(until: number, now: number) {
  const delta = Math.max(until - now, 0)
  if (delta >= 3600) return `${Math.floor(delta / 3600)}h ${Math.floor((delta % 3600) / 60)}m`
  if (delta >= 60) return `${Math.floor(delta / 60)}m ${delta % 60}s`
  return `${delta}s`
}

function formatDateTime(ts: number) {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default App
