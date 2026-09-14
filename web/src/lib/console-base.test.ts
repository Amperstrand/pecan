import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The module reads window.location.pathname once at import time — stub the
// minimum (pattern from currency.test.ts) and re-import per case.
function stubPathname(pathname: string) {
  vi.stubGlobal("window", { location: { pathname } })
}

async function loadBase() {
  return await import("./console-base")
}

describe("console base derivation", () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  it("is empty when the SPA is served at the origin root", async () => {
    stubPathname("/login")
    const { consoleBase, withBase, stripBase } = await loadBase()
    expect(consoleBase).toBe("")
    expect(withBase("/api/app")).toBe("/api/app")
    expect(withBase("/events")).toBe("/events")
    expect(stripBase("/teller")).toBe("/teller")
  })

  it("derives the pair prefix under /nok-console", async () => {
    stubPathname("/nok-console/login")
    const { consoleBase, withBase, stripBase } = await loadBase()
    expect(consoleBase).toBe("/nok-console")
    expect(withBase("/api/app")).toBe("/nok-console/api/app")
    expect(withBase("/api/login")).toBe("/nok-console/api/login")
    expect(withBase("/events")).toBe("/nok-console/events")
    expect(stripBase("/nok-console")).toBe("/")
    expect(stripBase("/nok-console/")).toBe("/")
    expect(stripBase("/nok-console/login")).toBe("/login")
    expect(stripBase("/nok-console/teller")).toBe("/teller")
  })

  it("keeps wallet routing working under a console prefix", async () => {
    stubPathname("/eur-console/wallet")
    const { consoleBase, stripBase } = await loadBase()
    expect(consoleBase).toBe("/eur-console")
    expect(stripBase("/eur-console/wallet")).toBe("/wallet")
  })

  it("never treats non-console leading segments as a base", async () => {
    stubPathname("/wallet")
    const { consoleBase } = await loadBase()
    expect(consoleBase).toBe("")

    vi.resetModules()
    stubPathname("/v1/some/mint/path")
    expect((await loadBase()).consoleBase).toBe("")
  })
})
