/**
 * Races a promise against a deadline. The wallet's mint calls must never
 * hang forever: a stalled fetch holds a browser connection, and enough
 * of them exhaust the per-origin pool until every new request queues
 * indefinitely — the user sees an eternal spinner. Surfacing a timeout
 * error is safe here: quote operations are resumable (prepared ops
 * resume on reload), so retrying after a timeout cannot double-spend.
 */
export function raceTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Mint request timed out (${what}) — check the connection and try again; in-flight operations are safe and resume on reload.`,
          ),
        ),
      ms,
    )
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}
