import { describe, expect, test } from "bun:test"
import type { GoalView } from "../../src/rpc"
import { bannerText, bar, cardLines, fmtDuration, pillText, statusText } from "../../src/tui/format"

const view: GoalView = {
  slug: "checkout-latency",
  title: "Checkout p95 under 250ms",
  outcome: "Checkout API p95 is below 250ms",
  status: "running",
  runId: "r1",
  turn: 7,
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
  test("the sidebar card renders status, criteria board, step, budgets and the last verdict", () => {
    const lines = cardLines(view, 0, 40).map((l) => l.text)
    expect(lines).toMatchSnapshot()
    expect(lines.every((l) => l.length <= 40)).toBe(true)
    expect(lines[0]).toMatch(/^◎ Goal .*▶ running$/)
    expect(lines).toContain("criteria ■■■□□□□□□□ 1/4")
    expect(lines.some((l) => l.startsWith("step 2/3 S2 Remove N+1"))).toBe(true)
    expect(lines).toContain("turn 7/40 · 42m/3h")
    expect(lines).toContain("1.2M/3.0M tok · $4.10/$15")
    expect(lines.find((l) => l.includes("C1"))).toMatch(/^✓ C1 checkout tests green\s+host$/)
    expect(lines.some((l) => l.startsWith("⚠ C2 FAILED"))).toBe(true)
  })

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
