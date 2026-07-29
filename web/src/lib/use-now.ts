import { useEffect, useRef, useState } from "react"

/**
 * A ticking unix-seconds clock, offset-corrected against the server's
 * `snapshot.now` so countdowns (quote expiry) and ages don't drift with
 * local clock skew.
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
