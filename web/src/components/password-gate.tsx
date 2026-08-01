import { useState, type FormEvent, type ReactNode } from "react"

import { changePassword, logout } from "@/lib/api"
import { navigate } from "@/lib/router"
import { useSnapshot } from "@/lib/snapshot"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/shared/bits"

/**
 * Blocks the console while the signed-in account is still on its
 * installer-provisioned password. The normal path never sees this — the login
 * page collects the new password in one flow — but a reload or a second tab
 * mid-flow lands here. The server refuses every other mutation until the
 * password is changed, so this is honesty, not the enforcement.
 */
export function PasswordGate({ children }: { children: ReactNode }) {
  const { snapshot, refresh } = useSnapshot()

  if (!snapshot.session.must_change_password) {
    return <>{children}</>
  }
  return <ForcedChangeScreen minLength={snapshot.password_min_length} refresh={refresh} />
}

function ForcedChangeScreen({
  minLength,
  refresh,
}: {
  minLength: number
  refresh: () => Promise<void>
}) {
  const [current, setCurrent] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await changePassword(current, password, confirm)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the password.")
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    try {
      await logout()
    } finally {
      navigate("/login")
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-[380px] rounded-xl border bg-card p-7 shadow-xs">
        <div className="grid justify-items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-md bg-primary text-lg font-bold text-primary-foreground">
            ◐
          </div>
          <h1 className="m-0 text-lg font-semibold">Set a new password</h1>
          <p className="m-0 text-sm text-muted-foreground">
            The installation password was for first sign-in only. Choose your own to continue —
            at least {minLength} characters.
          </p>
        </div>
        <form className="mt-6 grid gap-4" onSubmit={submit}>
          <Field label="Current password" htmlFor="gate-current">
            <Input
              id="gate-current"
              type="password"
              value={current}
              autoFocus
              autoComplete="current-password"
              onChange={(event) => setCurrent(event.target.value)}
              required
            />
          </Field>
          <Field label="New password" htmlFor="gate-new">
            <Input
              id="gate-new"
              type="password"
              value={password}
              minLength={minLength}
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </Field>
          <Field label="Confirm new password" htmlFor="gate-confirm">
            <Input
              id="gate-confirm"
              type="password"
              value={confirm}
              minLength={minLength}
              autoComplete="new-password"
              onChange={(event) => setConfirm(event.target.value)}
              required
            />
          </Field>
          {error && (
            <Alert variant="emphasis">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          )}
          <Button type="submit" size="lg" loading={busy}>
            Save and continue
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </form>
      </div>
    </main>
  )
}
