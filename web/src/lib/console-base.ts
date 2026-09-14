// One bundle serves every pair: the edge proxy mounts each pecan console
// under `{currency}-console/*` and strips the prefix before proxying, while
// local dev and direct-port installs serve the SPA at the origin root. The
// app therefore derives its API/event/router base from the URL at load time:
// the leading `…-console` segment when present, else "".
//
// Without this, fetch("/api/app") from /nok-console/ lands on the origin
// root — a different pair (or the static site) — and the console breaks.

const match =
  typeof window === "undefined"
    ? null
    : window.location.pathname.match(/^\/[a-z0-9]+-console(?=\/|$)/)

/** "" when served at the root, else e.g. "/nok-console". */
export const consoleBase: string = match ? match[0] : ""

/** Prefix a root-absolute app path (/api/…, /events) with the console base. */
export function withBase(path: string): string {
  return consoleBase + path
}

/** Strip the console base from a pathname ("/nok-console/login" → "/login"). */
export function stripBase(pathname: string): string {
  if (consoleBase && pathname.startsWith(consoleBase)) {
    return pathname.slice(consoleBase.length) || "/"
  }
  return pathname
}
