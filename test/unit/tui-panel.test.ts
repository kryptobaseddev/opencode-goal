import { describe, expect, test } from "bun:test"
import type { GoalView } from "../../src/rpc"
import { panelLines } from "../../src/tui/format"

const at = 1_760_000_000_000

const view: GoalView = {
  slug: "checkout-latency",
  title: "Checkout p95 under 250ms",
  outcome: "Checkout API p95 is below 250ms",
  status: "verifying",
  runId: "r-9f2",
  turn: 9,
  timeline: [
    { t: at, kind: "start", text: "run started via command" },
    { t: at + 60_000, kind: "admit", text: "turn 1 admitted (kickoff)" },
    { t: at + 120_000, kind: "claim", text: "completion claimed at turn 4" },
    { t: at + 180_000, kind: "verdict", text: "verdict failed — C2 FAILED [host] p95 312ms" },
    { t: at + 240_000, kind: "admit", text: "turn 5 admitted (verdict)" },
  ],
  activeMs: 61 * 60_000,
  activeSince: null,
  usage: { tokens: 1_450_000, cost: 5.25 },
  budget: [
    { name: "turns", used: 9, limit: 40 },
    { name: "tokens", used: 1_450_000, limit: 3_000_000 },
    { name: "cost", used: 5.25, limit: 15 },
  ],
  budgetRatio: 0.45,
  criteria: [
    { id: "C1", statement: "checkout tests green", essential: true, invariant: false, kind: "command", status: "pass", by: "host", detail: "bun test: 42 pass, 0 fail" },
    { id: "C2", statement: "p95 under 250ms across 3 runs", essential: true, invariant: false, kind: "command", status: "fail", by: "host", detail: "C2 FAILED [host] p95 312ms (run 2/3)" },
    { id: "C3", statement: "docs/perf.md explains the fix", essential: false, invariant: false, kind: "verifier", status: "unknown" },
    { id: "I1", statement: "full suite still passes", essential: true, invariant: true, kind: "command", status: "unknown" },
  ],
  steps: [
    { id: "S1", title: "Profile the slow path", status: "done" },
    { id: "S2", title: "Remove N+1 in loadCart", status: "active" },
    { id: "S3", title: "Document the change", status: "pending" },
  ],
  progress: { note: "ran bench: p95 231ms (-38%)", at, turn: 7 },
  verdict: { passed: false, lines: ["C2 FAILED [host] p95 312ms", "C1 passed [host] bun test: 42 pass"], at, turn: 8 },
  awaitingUser: false,
  amendments: 0,
  flags: 0,
  updatedAt: at,
}

describe("tui goal dashboard panel", () => {
  test("renders the criteria board with per-criterion evidence, plan, verdict and ledger timeline", () => {
    const lines = panelLines(view, at, 60)
    expect(lines).toMatchSnapshot()
    const text = lines.map((l) => l.text)

    // header + status
    expect(text[0]).toMatch(/^◎ GOAL ◐ verifying$/)
    expect(text.some((l) => l.includes("Checkout p95 under 250ms"))).toBe(true)
    expect(text.some((l) => l.includes("turn 9/40"))).toBe(true)

    // budget cells
    expect(text.some((l) => l.includes("9/40"))).toBe(true)
    expect(text.some((l) => l.includes("1.4M/3.0M tok"))).toBe(true)
    expect(text.some((l) => l.includes("$5.25/$15.00"))).toBe(true)

    // the criteria board, one line per criterion with its evidence below it
    expect(text.some((l) => l.startsWith("Criteria ■") && l.endsWith("1/4"))).toBe(true)
    expect(text.some((l) => l.startsWith("✓ C1") && l.includes("[host]"))).toBe(true)
    expect(text.some((l) => l.startsWith("✗ C2") && l.includes("p95 under 250ms"))).toBe(true)
    expect(text.some((l) => l.includes("bun test: 42 pass, 0 fail"))).toBe(true)
    expect(text.some((l) => l.includes("C2 FAILED [host] p95 312ms (run 2/3)"))).toBe(true)
    expect(text.some((l) => l.includes("[invariant]"))).toBe(true)

    // plan steps
    expect(text.some((l) => l.startsWith("▸ S2 Remove N+1"))).toBe(true)
    expect(text.some((l) => l.startsWith("✓ S1 Profile"))).toBe(true)

    // the latest verdict with its lines
    expect(text.some((l) => l.startsWith("Verdict — turn 8: failed"))).toBe(true)
    expect(text.some((l) => l.includes("C1 passed [host] bun test: 42 pass"))).toBe(true)

    // the ledger timeline, oldest first
    expect(text.some((l) => l.startsWith("Timeline"))).toBe(true)
    expect(text.filter((l) => l.includes("turn 1 admitted"))).toHaveLength(1)
    expect(text.some((l) => l.includes("verdict failed — C2 FAILED"))).toBe(true)
    const admitAt = text.findIndex((l) => l.includes("turn 1 admitted"))
    const claimAt = text.findIndex((l) => l.includes("completion claimed"))
    expect(claimAt).toBeGreaterThan(admitAt)

    // every line respects the panel width
    expect(lines.every((l) => l.text.length <= 60)).toBe(true)
  })

  test("an empty ledger and a passing verdict render their own shapes", () => {
    const empty: GoalView = {
      ...view,
      status: "running",
      timeline: [],
      verdict: undefined,
      progress: undefined,
      criteria: view.criteria.map((c) => ({ ...c, detail: undefined })),
    }
    const text = panelLines(empty, at, 46).map((l) => l.text)
    expect(text.some((l) => l.includes("(no events yet)"))).toBe(true)
    expect(text.some((l) => l.startsWith("Timeline"))).toBe(true)
    expect(text.some((l) => l.startsWith("Verdict"))).toBe(false)
    expect(text.some((l) => l.includes("bun test: 42 pass"))).toBe(false)

    const passed: GoalView = {
      ...view,
      status: "complete",
      verdict: { passed: true, lines: ["C1 passed [host]", "C2 passed [host]"], at, turn: 12 },
    }
    const text2 = panelLines(passed, at, 46).map((l) => l.text)
    expect(text2.some((l) => l.startsWith("Verdict — turn 12: passed"))).toBe(true)
  })
})
