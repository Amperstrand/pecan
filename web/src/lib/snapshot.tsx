import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"

import { ApiRequestError, fetchSnapshot, type AppSnapshot } from "@/lib/api"
import { navigate } from "@/lib/router"

interface SnapshotContextValue {
  snapshot: AppSnapshot
  refresh: () => Promise<void>
}

const SnapshotContext = createContext<SnapshotContextValue | null>(null)

export function useSnapshot(): SnapshotContextValue {
  const value = useContext(SnapshotContext)
  if (!value) throw new Error("useSnapshot must be used inside <SnapshotProvider>")
  return value
}

/**
 * Owns the /api/app snapshot: initial fetch, SSE-driven refreshes (debounced),
 * and the 401 → /login bounce. Children render only once a snapshot exists.
 */
export function SnapshotProvider({
  children,
  fallback,
  errorFallback,
}: {
  children: ReactNode
  fallback: ReactNode
  errorFallback: (error: string, retry: () => void) => ReactNode
}) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await fetchSnapshot()
      setSnapshot(data)
      setError(null)
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        navigate("/login")
        return
      }
      setError(err instanceof Error ? err.message : "Could not load the operator console.")
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

  if (error && !snapshot) {
    return <>{errorFallback(error, () => void refresh())}</>
  }
  if (!snapshot) {
    return <>{fallback}</>
  }
  return (
    <SnapshotContext.Provider value={{ snapshot, refresh }}>{children}</SnapshotContext.Provider>
  )
}
