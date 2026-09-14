import { useCallback, useSyncExternalStore } from "react"

import { stripBase, withBase } from "@/lib/console-base"

/**
 * Minimal SPA routing: three flat routes need no router library. pushState +
 * a custom event keep Console ↔ Teller switches instant (no full reloads).
 *
 * Paths are app-relative ("/", "/login", "/teller"): navigate() re-adds the
 * serving pair's console prefix (caddy strips it upstream) so the URL stays
 * reload-safe, and usePathname() reports it stripped so route matching works
 * identically at the root and under /{currency}-console.
 */

const NAVIGATE_EVENT = "app:navigate"

export function navigate(path: string) {
  if (stripBase(window.location.pathname) === path) return
  window.history.pushState(null, "", withBase(path))
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

function subscribe(callback: () => void) {
  window.addEventListener("popstate", callback)
  window.addEventListener(NAVIGATE_EVENT, callback)
  return () => {
    window.removeEventListener("popstate", callback)
    window.removeEventListener(NAVIGATE_EVENT, callback)
  }
}

export function usePathname() {
  return useSyncExternalStore(subscribe, () => stripBase(window.location.pathname))
}

/**
 * Hash-synced tab state for the console (`/#units` deep-links survive a
 * refresh). Uses replaceState so tab flips don't spam history.
 */
export function useHashTab(defaultTab: string): [string, (tab: string) => void] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  const tab = hash.replace(/^#/, "") || defaultTab
  const setTab = useCallback((next: string) => {
    window.history.replaceState(null, "", next === defaultTab ? window.location.pathname : `#${next}`)
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
  }, [defaultTab])
  return [tab, setTab]
}
