import { useState, type FormEvent } from "react"
import { Link2, TriangleAlert } from "lucide-react"

import {
  connectExternalMint,
  revealMnemonic,
  updateIdentity,
  useBundledMint,
  type AppSnapshot,
} from "@/lib/api"
import { runRestartingMutation } from "@/lib/restart"
import { useSnapshot } from "@/lib/snapshot"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { CopyButton, DetailRow, Field, MonoChip } from "@/components/shared/bits"

export function MintTab({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <div className="grid gap-4">
      <ConnectionCard snapshot={snapshot} />
      <IdentityCard snapshot={snapshot} />
      <FactsCard snapshot={snapshot} />
      <RecoveryCard />
    </div>
  )
}

function ConnectionCard({ snapshot }: { snapshot: AppSnapshot }) {
  const { refresh } = useSnapshot()
  const conn = snapshot.mint_connection
  const liveUnits = snapshot.units.some((unit) => unit.lifecycle !== "retired")
  const [busy, setBusy] = useState(false)

  async function switchToBundled() {
    setBusy(true)
    try {
      await runRestartingMutation("Switching to the bundled mint…", useBundledMint, refresh)
    } catch {
      // toast already shown by runRestartingMutation
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mint connection</CardTitle>
        <CardDescription>
          {conn.mode === "bundled" &&
            "The bundled cdk-mintd managed by this stack. It starts and stops with your units."}
          {conn.mode === "unset" &&
            "This installation runs the processor only — no mint is connected yet."}
          {conn.mode === "external" &&
            "An external cdk-mintd you operate. This processor is its payment backend."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {conn.mode === "unset" && (
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} onClick={() => void switchToBundled()}>
              Use the bundled mint
            </Button>
            <ExternalMintDialog trigger={<Button variant="outline">Connect an external mint</Button>} />
          </div>
        )}

        {conn.mode === "bundled" && (
          <>
            <div className="grid gap-2.5">
              <DetailRow label="Supply audit">
                <span className="text-sm">Available (reads the mint database directly)</span>
              </DetailRow>
              <DetailRow label="Keyset rotation">
                <span className="text-sm">Available over the management RPC</span>
              </DetailRow>
            </div>
            {liveUnits ? (
              <p className="m-0 text-sm text-muted-foreground">
                To connect a different mint, retire all units first — their ecash lives in this
                mint's database.
              </p>
            ) : (
              <div>
                <ExternalMintDialog
                  trigger={<Button variant="outline">Connect an external mint instead</Button>}
                />
              </div>
            )}
          </>
        )}

        {conn.mode === "external" && (
          <>
            <div className="grid gap-2.5">
              <DetailRow label="Mint URL">
                <MonoChip>{conn.http_url}</MonoChip>
              </DetailRow>
              <DetailRow label="Management RPC">
                {conn.rpc_url ? (
                  <MonoChip>{conn.rpc_url}</MonoChip>
                ) : (
                  <span className="text-sm">
                    Not configured — keyset rotation and quote-TTL sync are off
                  </span>
                )}
              </DetailRow>
              <DetailRow label="Processor gRPC (as seen by the mint)">
                <MonoChip>{conn.advertised_grpc}</MonoChip>
              </DetailRow>
              <DetailRow label="Supply audit">
                <span className="text-sm">Unavailable for external mints (no database access)</span>
              </DetailRow>
            </div>
            {conn.external_snippet && (
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="m-0 text-sm font-medium">Config for your cdk-mintd</p>
                  <CopyButton value={conn.external_snippet} label="Copy mint.toml snippet" />
                </div>
                <pre className="m-0 max-h-64 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs leading-5">
                  {conn.external_snippet}
                </pre>
                <p className="m-0 text-sm text-muted-foreground">
                  Merge into your mint.toml and restart your mintd; the payment-backend tile on the
                  Overview turns Connected once it attaches. Re-apply after unit changes.
                </p>
              </div>
            )}
            {liveUnits ? (
              <p className="m-0 text-sm text-muted-foreground">
                To switch back to the bundled mint, retire all units first.
              </p>
            ) : (
              <div>
                <Button variant="outline" loading={busy} onClick={() => void switchToBundled()}>
                  Use the bundled mint instead
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function ExternalMintDialog({ trigger }: { trigger: React.ReactElement }) {
  const { refresh } = useSnapshot()
  const [open, setOpen] = useState(false)
  const [httpUrl, setHttpUrl] = useState("")
  const [rpcUrl, setRpcUrl] = useState("")
  const [advertisedGrpc, setAdvertisedGrpc] = useState(
    `http://${window.location.hostname}:50051`,
  )
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await runRestartingMutation(
        "Connecting the external mint…",
        () =>
          connectExternalMint({
            http_url: httpUrl,
            rpc_url: rpcUrl,
            advertised_grpc: advertisedGrpc,
          }),
        refresh,
      )
      setOpen(false)
    } catch {
      // toast already shown by runRestartingMutation
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Connect an external cdk-mintd</DialogTitle>
            <DialogDescription>
              Your mintd must be built from the same pinned cdk revision as this processor with
              the managed-units patch applied — the published custom-unit-mint image is exactly
              that build. Applying restarts the service briefly.
            </DialogDescription>
          </DialogHeader>
          <Field
            label="Mint URL"
            help="The mint's HTTP API as reachable from this processor."
            htmlFor="ext-http"
          >
            <Input
              id="ext-http"
              type="url"
              placeholder="http://10.0.0.7:8089"
              value={httpUrl}
              onChange={(event) => setHttpUrl(event.target.value)}
              required
              autoFocus
            />
          </Field>
          <Field
            label="Management RPC URL (optional)"
            help="Enables keyset rotation and quote-TTL sync."
            htmlFor="ext-rpc"
          >
            <Input
              id="ext-rpc"
              type="url"
              placeholder="http://10.0.0.7:8091"
              value={rpcUrl}
              onChange={(event) => setRpcUrl(event.target.value)}
            />
          </Field>
          <Field
            label="This processor's gRPC, as seen by the mint"
            help="Goes into the config snippet for your mintd."
            htmlFor="ext-grpc"
          >
            <Input
              id="ext-grpc"
              type="url"
              value={advertisedGrpc}
              onChange={(event) => setAdvertisedGrpc(event.target.value)}
              required
            />
          </Field>
          <Alert variant="emphasis">
            <Link2 />
            <AlertTitle>These links carry no authentication.</AlertTitle>
            <AlertDescription>
              Keep mint, RPC, and gRPC endpoints on the same host or a private network — never the
              open internet. The supply audit is unavailable for external mints.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Connect mint
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function IdentityCard({ snapshot }: { snapshot: AppSnapshot }) {
  const { refresh } = useSnapshot()
  const [name, setName] = useState(snapshot.mint.name)
  const [publicUrl, setPublicUrl] = useState(snapshot.endpoints.public_url)
  const [description, setDescription] = useState(snapshot.mint.description)
  const [descriptionLong, setDescriptionLong] = useState(snapshot.mint.description_long)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await runRestartingMutation(
        "Saving mint identity…",
        () =>
          updateIdentity({
            name,
            public_url: publicUrl,
            description,
            description_long: descriptionLong,
          }),
        refresh,
      )
    } catch {
      // toast already shown by runRestartingMutation
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mint identity</CardTitle>
        <CardDescription>
          Published to wallets. Saving restarts the service briefly; you stay signed in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Mint name" htmlFor="identity-name">
              <Input
                id="identity-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </Field>
            <Field
              label="Wallet-facing URL"
              help="The URL wallets scan or paste."
              htmlFor="identity-url"
            >
              <Input
                id="identity-url"
                type="url"
                value={publicUrl}
                onChange={(event) => setPublicUrl(event.target.value)}
                required
              />
            </Field>
          </div>
          <Field label="Short description" htmlFor="identity-description">
            <Input
              id="identity-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              required
            />
          </Field>
          <Field label="Long description" htmlFor="identity-description-long">
            <Textarea
              id="identity-description-long"
              rows={3}
              value={descriptionLong}
              onChange={(event) => setDescriptionLong(event.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" loading={busy}>
              Save identity
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function FactsCard({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fixed configuration</CardTitle>
        <CardDescription>
          Provided by the deployment environment and re-read at every start; not editable from the
          console.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2.5">
        <DetailRow label="Payment method">
          <MonoChip>{snapshot.mint.method}</MonoChip>
        </DetailRow>
        <DetailRow label="Primary unit">
          <MonoChip>{snapshot.mint.unit || "none yet"}</MonoChip>
        </DetailRow>
        <DetailRow label="Mint HTTP">
          <MonoChip>{snapshot.endpoints.mint_http_url}</MonoChip>
        </DetailRow>
        <DetailRow label="Management RPC">
          <MonoChip>{snapshot.endpoints.mint_rpc_url}</MonoChip>
        </DetailRow>
        <DetailRow label="Processor gRPC">
          <MonoChip>
            {snapshot.endpoints.processor_grpc_addr}:{snapshot.endpoints.processor_grpc_port}
          </MonoChip>
        </DetailRow>
        <DetailRow label="Version">
          <MonoChip>{snapshot.version}</MonoChip>
        </DetailRow>
      </CardContent>
    </Card>
  )
}

function RecoveryCard() {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState("")
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function reset(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) {
      // The phrase must not outlive the dialog.
      setPassword("")
      setMnemonic(null)
      setError(null)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await revealMnemonic(password)
      setMnemonic(result.mnemonic)
      setPassword("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reveal the recovery phrase.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recovery phrase</CardTitle>
        <CardDescription>
          The 24-word phrase generated at first boot restores the mint's signing keys. It is
          immutable — back it up somewhere safe.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Dialog open={open} onOpenChange={reset}>
          <DialogTrigger asChild>
            <Button variant="outline">Reveal recovery phrase</Button>
          </DialogTrigger>
          <DialogContent>
            {mnemonic ? (
              <div className="grid gap-4">
                <DialogHeader>
                  <DialogTitle>Recovery phrase</DialogTitle>
                  <DialogDescription>
                    Write it down. It is shown only while this dialog is open.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1 rounded-md border bg-muted p-3 font-mono text-sm leading-6">
                    {mnemonic}
                  </div>
                  <CopyButton value={mnemonic} label="Copy recovery phrase" />
                </div>
                <Alert variant="emphasis">
                  <TriangleAlert />
                  <AlertTitle>Anyone with this phrase can recreate the mint's keys.</AlertTitle>
                </Alert>
                <DialogFooter>
                  <Button onClick={() => reset(false)}>Done</Button>
                </DialogFooter>
              </div>
            ) : (
              <form className="grid gap-4" onSubmit={submit}>
                <DialogHeader>
                  <DialogTitle>Confirm your password</DialogTitle>
                  <DialogDescription>
                    Re-enter your password to reveal the recovery phrase.
                  </DialogDescription>
                </DialogHeader>
                <Field label="Password" htmlFor="reveal-password">
                  <Input
                    id="reveal-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                    autoFocus
                  />
                </Field>
                {error && (
                  <Alert variant="emphasis">
                    <AlertTitle>{error}</AlertTitle>
                  </Alert>
                )}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => reset(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" loading={busy}>
                    Reveal
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
