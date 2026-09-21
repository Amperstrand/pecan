import fs from "node:fs"
import path from "node:path"

/** Structured results for the farm test matrices — one JSON object per
 * line, append-only, so runs can be diffed and analyzed later
 * (scripts/farm-analyze.py). The runner truncates the file per run. */
const RESULTS = path.resolve("e2e/.results", "farm-matrix-results.jsonl")

export interface CaseRecord {
  run: string
  suite: string
  group: string
  case: string
  params?: Record<string, unknown>
  outcome: "pass" | "fail"
  detail?: string
  ms: number
  at: string
}

const RUN = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)

export function record(
  suite: string,
  group: string,
  testCase: string,
  params: Record<string, unknown> | undefined,
  outcome: "pass" | "fail",
  detail: string | undefined,
  ms: number,
): void {
  const line: CaseRecord = {
    run: RUN,
    suite,
    group,
    case: testCase,
    ...(params ? { params } : {}),
    outcome,
    ...(detail ? { detail: detail.slice(0, 300) } : {}),
    ms: Math.round(ms),
    at: new Date().toISOString(),
  }
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true })
  fs.appendFileSync(RESULTS, JSON.stringify(line) + "\n")
}

/** Wrap one enumerated case: runs it, records pass/fail + timing, and
 * rethrows so Playwright still reports the failure (the JSONL is for
 * analysis, the runner verdict is for CI). */
export async function caseOf(
  suite: string,
  group: string,
  testCase: string,
  params: Record<string, unknown> | undefined,
  body: () => Promise<string | void>,
): Promise<void> {
  const t0 = Date.now()
  try {
    const detail = await body()
    record(suite, group, testCase, params, "pass", typeof detail === "string" ? detail : undefined, Date.now() - t0)
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}` : String(e)
    record(suite, group, testCase, params, "fail", msg, Date.now() - t0)
    throw e
  }
}
