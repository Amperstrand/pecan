import { useState, type FormEvent } from "react"
import { TriangleAlert } from "lucide-react"

import { revealMnemonic, updateIdentity, type AppSnapshot } from "@/lib/api"
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
      <IdentityCard snapshot={snapshot} />
      <FactsCard snapshot={snapshot} />
      <RecoveryCard />
    </div>
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
          Published to wallets. Saving restarts the mint briefly; you stay signed in.
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
        <CardDescription>Set at first boot; not editable from the console.</CardDescription>
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
