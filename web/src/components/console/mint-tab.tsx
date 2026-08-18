import { useState, type FormEvent } from "react"
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Info,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react"
import { toast } from "sonner"

import {
  runSelfTest,
  saveAttachment,
  type AppSnapshot,
  type CheckStatus,
  type ChecklistItem,
  type SelfTestLeg,
} from "@/lib/api"
import { formatAge, formatDateTime } from "@/lib/format"
import { useSnapshot } from "@/lib/snapshot"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CopyButton, DetailRow, EmptyState, Field, MonoChip } from "@/components/shared/bits"
import { KeysetBadge } from "@/components/shared/badges"

export function MintTab({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <div className="grid gap-4">
      {snapshot.migrated_from_managed && <MigrationNotice />}
      <AttachmentCard snapshot={snapshot} />
      <ChecklistCard snapshot={snapshot} />
      <SnippetCard snapshot={snapshot} />
      <SelfTestCard snapshot={snapshot} />
      {snapshot.mint_identity && <IdentityCard snapshot={snapshot} />}
      {snapshot.setup.unit && snapshot.setup.attached && <KeysetsCard snapshot={snapshot} />}
    </div>
  )
}

function MigrationNotice() {
  return (
    <Alert>
      <Info />
      <AlertTitle>This install previously managed its own mint</AlertTitle>
      <AlertDescription>
        The old configuration — including the bundled mint's recovery phrase — is preserved as
        setup.json.v3-managed.bak in the config directory. The mint itself, its database, keys,
        and backups now belong to whoever operates it.
      </AlertDescription>
    </Alert>
  )
}

// ---------------------------------------------------------------------------
// Attachment (setup)
// ---------------------------------------------------------------------------

function AttachmentCard({ snapshot }: { snapshot: AppSnapshot }) {
  const { refresh } = useSnapshot()
  const setup = snapshot.setup
  const [editing, setEditing] = useState(!setup.setup_complete)
  const [unit, setUnit] = useState(setup.unit)
  const [mintUrl, setMintUrl] = useState(setup.mint_url)
  const [grpc, setGrpc] = useState(setup.advertised_grpc || defaultGrpc())
  const [busy, setBusy] = useState(false)

  function defaultGrpc() {
    return `${window.location.hostname}:${setup.published_grpc_port}`
  }

  function startEditing() {
    setUnit(setup.unit)
    setMintUrl(setup.mint_url)
    setGrpc(setup.advertised_grpc || defaultGrpc())
    setEditing(true)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await saveAttachment({
        unit: setup.unit_change_allowed ? unit : undefined,
        mint_url: mintUrl,
        advertised_grpc: grpc,
      })
      toast.success("Attachment saved — no restart needed")
      setEditing(false)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the attachment.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mint attachment</CardTitle>
        <CardDescription>
          This processor serves one unit for one cdk-mintd you operate. It never changes the
          mint's configuration — the checklist below verifies it instead.
        </CardDescription>
        {!editing && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={startEditing}>
              Edit
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <form className="grid gap-4" onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field
                label="Unit"
                htmlFor="attach-unit"
                help={
                  setup.unit_change_allowed
                    ? "Lowercase letters, digits, - and _. Locks after the first successful self-test."
                    : "Locked — issued ecash and quotes reference this unit."
                }
              >
                <Input
                  id="attach-unit"
                  className="font-mono"
                  value={unit}
                  onChange={(event) => setUnit(event.target.value.toLowerCase())}
                  disabled={!setup.unit_change_allowed}
                  placeholder="ora"
                  required
                  autoFocus={setup.unit_change_allowed}
                />
              </Field>
              <Field
                label="Mint URL"
                htmlFor="attach-mint-url"
                help="The mint's public API base — the same URL wallets use."
              >
                <Input
                  id="attach-mint-url"
                  type="url"
                  value={mintUrl}
                  onChange={(event) => setMintUrl(event.target.value)}
                  placeholder="https://mint.example.org"
                  required
                />
              </Field>
              <Field
                label="Processor gRPC, as seen by the mint"
                htmlFor="attach-grpc"
                help="host or host:port; goes into the config snippet."
              >
                <Input
                  id="attach-grpc"
                  className="font-mono"
                  value={grpc}
                  onChange={(event) => setGrpc(event.target.value)}
                  placeholder="10.0.0.5:50051"
                  required
                />
              </Field>
            </div>
            <div className="flex gap-2">
              {setup.setup_complete && (
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
              <Button type="submit" loading={busy}>
                Save attachment
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-2.5">
            <DetailRow label="Unit">
              <span className="inline-flex items-center gap-2">
                <MonoChip>{setup.unit || "not set"}</MonoChip>
                {setup.unit_locked && <Badge variant="muted">Locked</Badge>}
              </span>
            </DetailRow>
            <DetailRow label="Payment method">
              <MonoChip>{setup.method}</MonoChip>
            </DetailRow>
            <DetailRow label="Mint URL">
              <MonoChip>{setup.mint_url || "not set"}</MonoChip>
            </DetailRow>
            <DetailRow label="gRPC, as seen by the mint">
              <MonoChip>{setup.advertised_grpc || "not set"}</MonoChip>
            </DetailRow>
            <DetailRow label="Listening on">
              <span className="inline-flex items-center gap-2">
                <MonoChip>{setup.grpc_bind}</MonoChip>
                <span className="text-sm text-muted-foreground">
                  {setup.grpc_tls ? "TLS on" : "no TLS — private network only"}
                </span>
              </span>
            </DetailRow>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

function checkIcon(status: CheckStatus) {
  switch (status) {
    case "ok":
      return <CircleCheck />
    case "warn":
      return <TriangleAlert />
    case "fail":
      return <CircleAlert />
    default:
      return <CircleDashed />
  }
}

function CheckBadge({ status }: { status: CheckStatus }) {
  if (status === "ok") return <Badge variant="solid">OK</Badge>
  if (status === "warn") return <Badge variant="outline">Warning</Badge>
  if (status === "fail")
    return (
      <Badge variant="outline">
        <X />
        Failing
      </Badge>
    )
  return <Badge variant="muted">Waiting</Badge>
}

function ChecklistRow({ check }: { check: ChecklistItem }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{checkIcon(check.status)}</span>
      <div className="min-w-0 flex-1 grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{check.title}</span>
          <CheckBadge status={check.status} />
        </div>
        <p className="m-0 text-sm text-muted-foreground">{check.detail}</p>
        {check.remedy && (
          <div className="mt-1 rounded-md border bg-muted p-2.5 text-sm leading-6">
            {check.remedy}
          </div>
        )}
      </div>
    </div>
  )
}

function ChecklistCard({ snapshot }: { snapshot: AppSnapshot }) {
  const { refresh } = useSnapshot()
  const signals = snapshot.attach_signals
  return (
    <Card>
      <CardHeader>
        <CardTitle>Attachment checklist</CardTitle>
        <CardDescription>
          Verified live against the mint's public API and this processor's own signals.
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon" aria-label="Refresh checklist" onClick={() => void refresh()}>
            <RefreshCw />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {snapshot.checklist.map((check) => (
          <ChecklistRow key={check.id} check={check} />
        ))}
        <p className="m-0 text-xs text-muted-foreground">
          {signals.last_settings_at
            ? `Settings last read by the mint ${formatAge(signals.last_settings_at, snapshot.now)}`
            : "Settings never read by a mint since this processor started"}
          {" · "}
          {signals.stream_attached_at
            ? `payment stream attached ${formatAge(signals.stream_attached_at, snapshot.now)}`
            : "payment stream not attached"}
        </p>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Config snippet
// ---------------------------------------------------------------------------

function SnippetCard({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Config for your cdk-mintd</CardTitle>
        <CardDescription>
          Apply to your mintd&apos;s stored configuration (cdk-mintd config apply — the
          snippet&apos;s header shows the exact commands), then restart your mintd. The
          checklist settles itself once the mint reconnects.
        </CardDescription>
        {snapshot.snippet && (
          <CardAction>
            <CopyButton value={snapshot.snippet} label="Copy mint.toml snippet" />
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {snapshot.snippet ? (
          <pre className="m-0 max-h-72 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs leading-5">
            {snapshot.snippet}
          </pre>
        ) : (
          <EmptyState
            title="No snippet yet"
            body="Complete the attachment above — the snippet is generated from the unit and this processor's gRPC endpoint."
          />
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function LegLine({ leg }: { leg: SelfTestLeg }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">
        {leg.ok ? <CircleCheck /> : <CircleAlert />}
      </span>
      <div className="min-w-0 text-sm">
        {leg.detail}
        {leg.remedy && <p className="m-0 mt-1 text-muted-foreground">{leg.remedy}</p>}
      </div>
    </div>
  )
}

function formatTtl(secs: number) {
  return secs >= 120 ? `${Math.round(secs / 60)} min` : `${secs} s`
}

function SelfTestCard({ snapshot }: { snapshot: AppSnapshot }) {
  const { refresh } = useSnapshot()
  const [busy, setBusy] = useState(false)
  const result = snapshot.self_test
  const unitLabel = snapshot.setup.unit ? snapshot.setup.unit.toUpperCase() : "unit"

  async function run() {
    setBusy(true)
    try {
      await runSelfTest()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The self-test could not run.")
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>End-to-end self-test</CardTitle>
        <CardDescription>
          Creates one deposit and one payout quote at the mint (1 {unitLabel} each), verifies
          both arrive at this processor, then voids them. The quotes stay unpaid at the mint and
          expire on their own — safe to run anytime.
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            loading={busy}
            disabled={!snapshot.setup.setup_complete}
            onClick={() => void run()}
          >
            Run self-test
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {!result ? (
          <p className="m-0 text-sm text-muted-foreground">
            Not run yet — it runs automatically the first time the mint links up.
          </p>
        ) : (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {result.ok ? (
                <Badge variant="solid">Passed</Badge>
              ) : (
                <Badge variant="outline">
                  <X />
                  Failed
                </Badge>
              )}
              <span className="text-sm text-muted-foreground">
                {formatAge(result.ran_at, snapshot.now)}
                {result.latency_ms != null && ` · ${result.latency_ms} ms round trip`}
              </span>
            </div>
            <LegLine leg={result.deposit} />
            <LegLine leg={result.payout} />
            {(result.mint_quote_ttl_secs != null || result.melt_quote_ttl_secs != null) && (
              <p className="m-0 text-sm text-muted-foreground">
                Quote lifetimes at the mint:
                {result.mint_quote_ttl_secs != null &&
                  ` deposits ${formatTtl(result.mint_quote_ttl_secs)}`}
                {result.mint_quote_ttl_secs != null && result.melt_quote_ttl_secs != null && " ·"}
                {result.melt_quote_ttl_secs != null &&
                  ` payouts ${formatTtl(result.melt_quote_ttl_secs)}`}
              </p>
            )}
            {result.warnings.map((warning) => (
              <div key={warning} className="flex items-start gap-2.5 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{warning}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Read-only mint facts
// ---------------------------------------------------------------------------

function IdentityCard({ snapshot }: { snapshot: AppSnapshot }) {
  const identity = snapshot.mint_identity
  if (!identity) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mint identity</CardTitle>
        <CardDescription>
          Published by your mint — read-only here. Edit it in your mintd's [mint_info] section.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2.5">
        <DetailRow label="Name">
          <span className="text-sm">{identity.name || "—"}</span>
        </DetailRow>
        <DetailRow label="Description">
          <span className="text-sm">{identity.description || "—"}</span>
        </DetailRow>
        <DetailRow label="Version">
          <MonoChip>{identity.version || "unknown"}</MonoChip>
        </DetailRow>
      </CardContent>
    </Card>
  )
}

function KeysetsCard({ snapshot }: { snapshot: AppSnapshot }) {
  const unit = snapshot.setup.unit
  return (
    <Card>
      <CardHeader>
        <CardTitle>Keys for {unit.toUpperCase()}</CardTitle>
        <CardDescription>
          Managed by the mint; this processor only reads them.
        </CardDescription>
      </CardHeader>
      <CardContent className={snapshot.keysets.length > 0 ? "px-0" : undefined}>
        {snapshot.keysets_error ? (
          <p className="m-0 text-sm text-muted-foreground">
            Could not read the mint's keysets: {snapshot.keysets_error}
          </p>
        ) : snapshot.keysets.length === 0 ? (
          <EmptyState
            title="No keys yet"
            body="The mint creates keys for the unit on its first start with the snippet applied."
          />
        ) : (
          <Table className="min-w-[480px]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Keyset</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Input fee (ppk)</TableHead>
                <TableHead className="pr-6">Final expiry</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.keysets.map((keyset) => (
                <TableRow key={keyset.id}>
                  <TableCell className="pl-6 font-mono">{keyset.id}</TableCell>
                  <TableCell>
                    <KeysetBadge keyset={keyset} now={snapshot.now} />
                  </TableCell>
                  <TableCell className="font-mono">{keyset.input_fee_ppk}</TableCell>
                  <TableCell className="pr-6 text-muted-foreground">
                    {keyset.final_expiry ? formatDateTime(keyset.final_expiry) : "None"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
