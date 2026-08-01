import { useState, type FormEvent } from "react"

import { changePassword, login } from "@/lib/api"
import { navigate } from "@/lib/router"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/shared/bits"

export function LoginPage() {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set after a successful sign-in that requires choosing a real password
  // (installer-provisioned first password). Holds the minimum length rule.
  const [changeMinLength, setChangeMinLength] = useState<number | null>(null)
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await login(username, password)
      if (result.must_change_password) {
        setChangeMinLength(result.password_min_length)
      } else {
        navigate("/")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.")
    } finally {
      setBusy(false)
    }
  }

  async function submitNewPassword(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // The just-typed sign-in password doubles as the current password.
      await changePassword(password, newPassword, confirmPassword)
      navigate("/")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the password.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-[380px] rounded-xl border bg-card p-7 shadow-xs">
        <div className="grid justify-items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-md bg-primary text-lg font-bold text-primary-foreground">
            ◐
          </div>
          <h1 className="m-0 text-lg font-semibold">
            {changeMinLength === null ? "Sign in" : "Set a new password"}
          </h1>
          {changeMinLength !== null && (
            <p className="m-0 text-sm text-muted-foreground">
              The installation password was for first sign-in only. Choose your own to continue —
              at least {changeMinLength} characters.
            </p>
          )}
        </div>
        {changeMinLength === null ? (
          <form className="mt-6 grid gap-4" onSubmit={submit}>
            <Field label="Username" htmlFor="login-username">
              <Input
                id="login-username"
                value={username}
                autoFocus
                autoComplete="username"
                autoCapitalize="none"
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </Field>
            <Field label="Password" htmlFor="login-password">
              <Input
                id="login-password"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </Field>
            {error && (
              <Alert variant="emphasis">
                <AlertTitle>{error}</AlertTitle>
              </Alert>
            )}
            <Button type="submit" size="lg" loading={busy}>
              Sign in
            </Button>
          </form>
        ) : (
          <form className="mt-6 grid gap-4" onSubmit={submitNewPassword}>
            <Field label="New password" htmlFor="login-new-password">
              <Input
                id="login-new-password"
                type="password"
                value={newPassword}
                autoFocus
                minLength={changeMinLength}
                autoComplete="new-password"
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            </Field>
            <Field label="Confirm new password" htmlFor="login-confirm-password">
              <Input
                id="login-confirm-password"
                type="password"
                value={confirmPassword}
                minLength={changeMinLength}
                autoComplete="new-password"
                onChange={(event) => setConfirmPassword(event.target.value)}
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
          </form>
        )}
      </div>
    </main>
  )
}
