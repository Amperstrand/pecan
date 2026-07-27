import { useEffect, useRef, useState } from "react"

/**
 * A ticking unix-seconds clock, offset-corrected against the server's
 * `snapshot.now` so countdowns don't drift with local clock skew. Fixes the
 * previously frozen offer countdown (which only moved on SSE refreshes).
 */
export function useNow(serverNow: number, intervalMs = 1000) {
  const offsetRef = useRef(0)
  offsetRef.current = serverNow - Math.floor(Date.now() / 1000)
  const [now, setNow] = useState(serverNow)

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000) + offsetRef.current)
    tick()
    const timer = window.setInterval(tick, intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs, serverNow])

  return now
}
