import { useState, type FormEvent } from "react"

import { login } from "@/lib/api"
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

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username, password)
      navigate("/")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.")
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
          <h1 className="m-0 text-lg font-semibold">Sign in</h1>
        </div>
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
      </div>
    </main>
  )
}
