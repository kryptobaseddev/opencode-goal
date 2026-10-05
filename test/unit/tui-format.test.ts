import { describe, expect, test } from "bun:test"
import type { GoalView } from "../../src/rpc"
import { bannerText, bar, fmtDuration, pillText, statusText } from "../../src/tui/format"

const view: GoalView = {
  slug: "checkout-latency",
  title: "Checkout p95 under 250ms",
  outcome: "Checkout API p95 is below 250ms",
  status: "running",
  runId: "r1",
  turn: 7,
  timeline: [
    { t: 1_760_000_000_000, kind: "start", text: "run started via command" },
    { t: 1_760_000_060_000, kind: "admit", text: "turn 1 admitted (kickoff)" },
  ],
  activeMs: 42 * 60_000,
  activeSince: null,
  usage: { tokens: 1_200_000, cost: 4.1 },
  budget: [
    { name: "turns", used: 7, limit: 40 },
    { name: "wall", used: 0, limit: 3 * 3_600_000 },
    { name: "tokens", used: 1_200_000, limit: 3_000_000 },
    { name: "cost", used: 4.1, limit: 15 },
  ],
  budgetRatio: 0.4,
  criteria: [
    { id: "C1", statement: "checkout tests green", essential: true, invariant: false, kind: "command", status: "pass", by: "host" },
    { id: "C2", statement: "p95 under 250ms across 3 runs", essential: true, invariant: false, kind: "command", status: "fail", by: "host" },
    { id: "C3", statement: "docs/perf.md explains the fix", essential: false, invariant: false, kind: "verifier", status: "unknown" },
    { id: "I1", statement: "full suite still passes", essential: true, invariant: true, kind: "command", status: "unknown" },
  ],
  steps: [
    { id: "S1", title: "Profile the slow path", status: "done" },
    { id: "S2", title: "Remove N+1 in loadCart", status: "active" },
    { id: "S3", title: "Document the change", status: "pending" },
  ],
  progress: { note: "ran bench: p95 231ms (-38%)", at: 1, turn: 7 },
  verdict: { passed: false, lines: ["C2 FAILED [host] p95 312ms"], at: 1, turn: 6 },
  awaitingUser: false,
  amendments: 0,
  flags: 0,
  updatedAt: 1,
}

describe("tui formatting", () => {
  test("the pill and banner", () => {
    expect(pillText(view, 0)).toBe("◎ ▶ 1/4 · t7 · 42m")
    expect(bannerText(view)).toBeUndefined()
    expect(bannerText({ ...view, status: "blocked", reason: "x", blocker: { key: "k", count: 3, reason: "need the API token" } })?.text).toMatch(/blocked — need the API token/)
    expect(bannerText({ ...view, awaitingUser: true })?.text).toMatch(/waiting for your answer/)
  })

  test("helpers", () => {
    expect(bar(2, 4, 4)).toBe("■■□□")
    expect(fmtDuration(65 * 60_000)).toBe("1h 05m")
    expect(fmtDuration(30_000)).toBe("30s")
    expect(statusText(view, 0)).toMatch(/✗ C2 p95 under 250ms/)
  })
})
