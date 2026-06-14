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
  LockKeyhole,
  LogOut,
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
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
            <span className="text-xs font-medium text-muted-foreground">Unit</span>
            <span className="font-mono text-xs font-medium uppercase">{snapshot.mint.unit}</span>
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
          label="Estimated circulation"
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
        description="Create one branch quote at a time, scan it with the wallet, then confirm settlement after cash changes hands."
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
            <DetailRow label="Unit">
              <span className="font-mono uppercase">{snapshot.mint.unit}</span>
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
  const [amount, setAmount] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost<Ticket>("/api/quotes", {
        kind: kind === "incoming" ? "mint" : "melt",
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
          <CardTitle>Create quote</CardTitle>
          <CardDescription>The teller starts each branch quote from this screen.</CardDescription>
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
              <Input value={`${snapshot.mint.unit} · ${snapshot.mint.method}`} readOnly />
            </Field>
          </div>
          <Field label="Note">
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional receipt or customer reference"
            />
          </Field>
          {error && <Alert variant="danger">{error}</Alert>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" loading={busy} disabled={busy}>
              <Banknote />
              Create quote
            </Button>
            <span className="text-xs text-muted-foreground">
              The processor allows one active quote at a time.
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
  const copyUrl = async () => {
    if (!ticket.quote_url) return
    await navigator.clipboard?.writeText(ticket.quote_url)
  }
  const incoming = ticket.kind === "incoming"
  const waiting = ticket.status === "waiting"
  const title = incoming ? "Cash deposit" : "Cash dispense"
  const subtitle = incoming
    ? "Customer pays cash before ecash is issued."
    : waiting
      ? "Waiting for the wallet to lock ecash."
      : "Ecash is locked; cash can be handed over."

  async function mutate(kind: "paid" | "failed") {
    setBusy(kind)
    setError(null)
    try {
      await apiPost<Ticket>(`/api/tickets/${encodeURIComponent(ticket.id)}/mark-${kind}`, { notes })
      setNotes("")
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
              <DetailBlock label="Quote">
                <span className="mono-chip">{ticket.quote_id ?? ticket.id}</span>
              </DetailBlock>
              <DetailBlock label="Ticket">
                <span className="mono-chip">{ticket.id}</span>
              </DetailBlock>
              <DetailBlock label="Created">{formatAge(ticket.created_at, now)}</DetailBlock>
              {ticket.description && <DetailBlock label="Note">{ticket.description}</DetailBlock>}
            </div>
            {ticket.quote_url && (
              <div className="mt-4 grid gap-2">
                <Label>Fetch URL</Label>
                <div className="flex min-w-0 gap-2">
                  <div className="min-w-0 flex-1 rounded-sm border border-border bg-surface-muted px-3 py-2 font-mono text-xs text-muted-foreground break-all">
                    {ticket.quote_url}
                  </div>
                  <Button type="button" size="icon" onClick={() => void copyUrl()} aria-label="Copy fetch URL">
                    <Copy />
                  </Button>
                </div>
              </div>
            )}
          </div>
          <div className="qr-box grid place-items-center rounded-md border border-border bg-white p-3">
            {ticket.qr_svg ? (
              <div dangerouslySetInnerHTML={{ __html: ticket.qr_svg }} />
            ) : (
              <div className="grid aspect-square w-full place-items-center rounded-sm border border-dashed border-border-strong text-sm text-muted-foreground">
                No quote id
              </div>
            )}
          </div>
        </div>

        {error && <Alert variant="danger">{error}</Alert>}

        <div className="border-t border-border pt-4">
          {ticket.status === "waiting" ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" loading={busy === "failed"} onClick={() => void mutate("failed")}>
                <XCircle />
                Cancel quote
              </Button>
            </div>
          ) : (
            <div className="settlement-grid">
              <Input
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Receipt note (optional)"
              />
              <div className="flex flex-wrap gap-2">
                <Button variant="success" loading={busy === "paid"} onClick={() => void mutate("paid")}>
                  <CheckCircle2 />
                  {incoming ? "Cash received" : "Cash handed over"}
                </Button>
                <Button variant="danger" loading={busy === "failed"} onClick={() => void mutate("failed")}>
                  <XCircle />
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function KeysetsPage({ snapshot, onRefresh }: { snapshot: AppSnapshot; onRefresh: () => Promise<void> }) {
  const [unit, setUnit] = useState(snapshot.mint.unit)
  const [amounts, setAmounts] = useState(snapshot.default_amounts.join(","))
  const [fee, setFee] = useState("0")
  const [finalExpiry, setFinalExpiry] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
        title={`Keysets · ${snapshot.mint.unit}`}
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
                <Input value={unit} onChange={(event) => setUnit(event.target.value)} />
              </Field>
              <Field label="Input fee (ppk)">
                <Input type="number" min="0" value={fee} onChange={(event) => setFee(event.target.value)} />
              </Field>
            </div>
            <Field label="Amounts" help="Comma-separated powers of 2 for the denominations this keyset will sign.">
              <Input value={amounts} onChange={(event) => setAmounts(event.target.value)} />
            </Field>
            <Field
              label="Final expiry · unix seconds"
              help="Immutable once created. Leave blank for no expiry."
            >
              <Input
                type="number"
                min="0"
                value={finalExpiry}
                placeholder="leave blank for no expiry"
                onChange={(event) => setFinalExpiry(event.target.value)}
              />
            </Field>
            {error && <Alert variant="danger">{error}</Alert>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" loading={busy} disabled={busy}>
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
  return (
    <>
      <PageHeader
        title="Settings"
        description="Committed mint configuration and rollover policy. Immutable values require a deliberate reset."
      />
      <section className="two-column-grid">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Mint configuration</CardTitle>
              <CardDescription>Values committed during first-run setup.</CardDescription>
            </div>
            <Badge>Read-only</Badge>
          </CardHeader>
          <CardContent className="detail-grid">
            <DetailRow label="Name">{snapshot.mint.name}</DetailRow>
            <DetailRow label="Unit">
              <span className="font-mono">{snapshot.mint.unit}</span>
            </DetailRow>
            <DetailRow label="Method">
              <span className="font-mono">{snapshot.mint.method}</span>
            </DetailRow>
            <DetailRow label="Public URL">
              <span className="font-mono text-xs break-all">{snapshot.endpoints.public_url}</span>
            </DetailRow>
            <DetailRow label="Mint HTTP">
              <span className="font-mono text-xs break-all">{snapshot.endpoints.mint_http_url}</span>
            </DetailRow>
            <DetailRow label="Management RPC">
              <span className="font-mono text-xs break-all">{snapshot.endpoints.mint_rpc_url}</span>
            </DetailRow>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Keyset rollover</CardTitle>
              <CardDescription>Expiry policy used by the background worker.</CardDescription>
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
            <DetailRow label="Input fee">
              <span className="font-mono">{snapshot.rollover.input_fee_ppk} ppk</span>
            </DetailRow>
            <DetailRow label="Denominations">
              <span className="font-mono text-xs break-all">{snapshot.rollover.amounts.join(",")}</span>
            </DetailRow>
          </CardContent>
        </Card>
      </section>
      <Alert variant="warning">
        Changing the unit, method, or recovery phrase requires a deliberate reset of processor,
        config, and mint data volumes. Drain and back up operational records before resetting a production mint.
      </Alert>
    </>
  )
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

  const valid =
    !!form &&
    !!form.name.trim() &&
    !!form.description.trim() &&
    validSetupSlug(form.unit.trim()) &&
    validSetupSlug(form.method.trim()) &&
    validHttpUrl(form.public_url) &&
    !!form.mnemonic.trim() &&
    form.keyset_lifetime_days >= 2 &&
    form.rotate_before_expiry_days >= 1 &&
    form.rotate_before_expiry_days < form.keyset_lifetime_days &&
    form.input_fee_ppk >= 0 &&
    validAmounts(form.amounts) &&
    Object.values(rules).every(Boolean) &&
    backupConfirmed

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
    <div className="min-h-screen px-4 py-8">
      <form className="mx-auto grid w-full max-w-[980px] gap-5" onSubmit={submit}>
        <div className="rounded-md border border-border bg-surface p-6 shadow-[var(--shadow-low)]">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
            <div className="max-w-[74ch]">
              <div className="mb-4 flex items-center gap-3">
                <div className="grid size-8 place-items-center rounded-sm bg-primary font-bold text-primary-foreground">
                  ◐
                </div>
                <div className="font-semibold">Branch</div>
              </div>
              <h1 className="m-0 text-2xl font-semibold leading-tight tracking-normal">
                Set up your custom unit mint
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                This writes the mint configuration, locks irreversible choices, and brings the mint online.
              </p>
            </div>
            <Badge variant="info">First run</Badge>
          </div>

          <div className="mt-5 grid gap-6">
            <SetupSection title="Mint identity">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Mint name">
                  <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
                </Field>
                <Field label="Wallet-facing URL" help="Use the URL wallets will scan or paste.">
                  <Input
                    type="url"
                    value={form.public_url}
                    onChange={(event) => setForm({ ...form, public_url: event.target.value })}
                    required
                  />
                </Field>
              </div>
              <Field label="Short description">
                <Input
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                  required
                />
              </Field>
              <Field label="Long description">
                <Textarea
                  rows={3}
                  value={form.description_long}
                  onChange={(event) => setForm({ ...form, description_long: event.target.value })}
                />
              </Field>
            </SetupSection>

            <SetupSection title="Immutable unit settings">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Custom unit" help="Lowercase unit code. This cannot be changed after provisioning.">
                  <Input
                    value={form.unit}
                    pattern="[a-z0-9_-]+"
                    onChange={(event) => setForm({ ...form, unit: event.target.value })}
                    required
                  />
                </Field>
                <Field label="Payment method" help="Use branch unless a wallet integration expects a different method.">
                  <Input
                    value={form.method}
                    pattern="[a-z0-9_-]+"
                    onChange={(event) => setForm({ ...form, method: event.target.value })}
                    required
                  />
                </Field>
              </div>
            </SetupSection>

            <SetupSection title="Operator access">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Operator password">
                  <Input
                    type="password"
                    minLength={defaults.password_min_length}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </Field>
                <Field label="Confirm password">
                  <Input
                    type="password"
                    minLength={defaults.password_min_length}
                    value={passwordConfirm}
                    onChange={(event) => setPasswordConfirm(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </Field>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
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
            </SetupSection>

            <SetupSection title="Recovery phrase">
              <Field
                label="Mint seed phrase"
                help="This restores Cashu mint signing keys and keysets. It does not control bitcoin funds in this processor."
              >
                <Textarea
                  rows={4}
                  value={form.mnemonic}
                  onChange={(event) => setForm({ ...form, mnemonic: event.target.value })}
                  required
                />
              </Field>
              <label className="flex items-start gap-3 text-sm">
                <input
                  className="mt-1 accent-primary"
                  type="checkbox"
                  checked={backupConfirmed}
                  onChange={(event) => setBackupConfirmed(event.target.checked)}
                  required
                />
                <span>
                  I have saved the recovery phrase and understand it is required to recover this mint's signing keys.
                </span>
              </label>
            </SetupSection>

            <SetupSection title="Keyset expiry">
              <label className="flex items-start gap-3 text-sm">
                <input
                  className="mt-1 accent-primary"
                  type="checkbox"
                  checked={form.rollover_enabled}
                  onChange={(event) => setForm({ ...form, rollover_enabled: event.target.checked })}
                />
                <span>Automatically rotate keysets before they expire.</span>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Keyset lifetime · days">
                  <Input
                    type="number"
                    min="2"
                    value={form.keyset_lifetime_days}
                    onChange={(event) => setForm({ ...form, keyset_lifetime_days: Number(event.target.value) })}
                    required
                  />
                </Field>
                <Field label="Rotate before expiry · days">
                  <Input
                    type="number"
                    min="1"
                    value={form.rotate_before_expiry_days}
                    onChange={(event) => setForm({ ...form, rotate_before_expiry_days: Number(event.target.value) })}
                    required
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Input fee (ppk)">
                  <Input
                    type="number"
                    min="0"
                    value={form.input_fee_ppk}
                    onChange={(event) => setForm({ ...form, input_fee_ppk: Number(event.target.value) })}
                    required
                  />
                </Field>
                <Field label="Denominations">
                  <Input value={form.amounts} onChange={(event) => setForm({ ...form, amounts: event.target.value })} required />
                </Field>
              </div>
            </SetupSection>

            <Alert variant="neutral">
              <strong className="font-semibold text-foreground">Locked after setup.</strong> Unit, method, recovery phrase,
              and initial mint identity become read-only after provisioning.
            </Alert>
            {error && <Alert variant="danger">{error}</Alert>}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" loading={busy} disabled={!valid || busy}>
                <ShieldCheck />
                Provision mint
              </Button>
              <span className={cn("text-sm text-muted-foreground", valid && "text-success")}>
                {valid ? "Ready to write configuration." : "Complete the required fields to continue."}
              </span>
            </div>
          </div>
        </div>
      </form>
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
  children,
}: {
  label: string
  help?: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
      {help && <p className="m-0 text-xs leading-5 text-muted-foreground">{help}</p>}
    </div>
  )
}

function SetupSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
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

function formatDateTime(ts: number) {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default App
