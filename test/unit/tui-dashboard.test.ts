import { describe, expect, test } from "bun:test"
import type { GoalView } from "../../src/rpc"
import { cardCompactLines, dashboardLines, decisionRows, dialogDigest, DASHBOARD_TABS, humanizedEvents } from "../../src/tui/dashboard"

// T056 — the dashboard rework. The v0.2 panel streamed raw ledger actions
// (a wall of text) and the sidebar was completely overtaken. Pinned here:
// the sidebar card is capped at 12 lines; the panel is organized into
// Now / Progress / Decisions / Goals tabs with plain-language criteria and
// a C/I/S legend footer; actionable rows are keyboard-selectable models;
// the raw ledger timeline never reaches the UI.

const at = 1_700_000_000_000

const view: GoalView = {
  slug: "demo",
  title: "Checkout stays fast under load",
  outcome: "p95 checkout latency stays under 250ms at 3× traffic",
  status: "needs_review",
  reason: "C2 rejected 3 times",
  runId: "r1",
  turn: 9,
  timeline: [
    { t: at - 90_000, kind: "admit", text: "turn 4 admitted (continue)" },
    { t: at - 60_000, kind: "turn", text: "turn 5 kind=continue tools=4" },
    { t: at - 45_000, kind: "verdict", text: "verdict failed — C2 FAILED [host] p95 312ms" },
    { t: at - 30_000, kind: "admit", text: "turn 6 admitted (verdict)" },
    { t: at - 15_000, kind: "verdict", text: "verdict failed — C2 rejected 3 times" },
  ],
  activeMs: 61 * 60_000,
  activeSince: null,
  usage: { tokens: 1_450_000, cost: 5.25 },
  budget: [
    { name: "turns", used: 9, limit: 40 },
    { name: "tokens", used: 1_450_000, limit: 3_000_000 },
  ],
  budgetRatio: 0.45,
  criteria: [
    { id: "C1", statement: "checkout tests green", essential: true, invariant: false, kind: "command", status: "pass", by: "host", detail: "bun test: 42 pass, 0 fail" },
    { id: "C2", statement: "p95 stays under 250ms across 3 runs", essential: true, invariant: false, kind: "command", status: "fail", by: "host", detail: "p95 312ms (run 2/3)" },
    { id: "C3", statement: "the fix is explained in plain language", essential: false, invariant: false, kind: "verifier", status: "unknown" },
    { id: "I1", statement: "the full suite still passes", essential: true, invariant: true, kind: "command", status: "unknown" },
  ],
  steps: [
    { id: "S1", title: "Profile the slow path", status: "done" },
    { id: "S2", title: "Remove the N+1 in loadCart", status: "active" },
    { id: "S3", title: "Document the change", status: "pending" },
  ],
  progress: { note: "ran bench: p95 231ms (-38%)", next: "re-run the 3× soak", at, turn: 7 },
  verdict: { passed: false, lines: ["C2 FAILED [host] p95 312ms (run 2/3)"], at, turn: 8 },
  actionRequired: "sign-off needed: C2 rejected 3 times (/goal approve <C#>)",
  awaitingUser: false,
  amendments: 0,
  flags: 0,
  updatedAt: at,
}

describe("compact sidebar card (T056 A)", () => {
  test("never exceeds 12 lines, shows the action-required line once and no timeline", () => {
    const lines = cardCompactLines(view, at, 40)
    expect(lines.length).toBeLessThanOrEqual(12)
    const text = lines.map((l) => l.text)
    expect(text[0]).toMatch(/^◎ Goal .*⚑ needs review$/)
    expect(text.filter((l) => l.startsWith("⚑"))).toHaveLength(1)
    expect(text.some((l) => l.includes("Checkout stays fast"))).toBe(true)
    expect(text.some((l) => l.includes("criteria ■"))).toBe(true)
    expect(text.some((l) => l.includes("S2 Remove the N+1"))).toBe(true)
    // no raw ledger/timeline lines ever reach the card
    expect(text.some((l) => l.includes("admitted") || l.includes("tools="))).toBe(false)
    expect(lines.every((l) => l.text.length <= 41)).toBe(true)
  })

  test("a long goal still fits: the cap trims, priorities keep failing criteria visible", () => {
    const many: GoalView = {
      ...view,
      criteria: Array.from({ length: 15 }, (_, i) => ({ id: `C${i + 1}`, statement: `criterion number ${i + 1} with a fairly long plain-language statement`, essential: i < 3, invariant: false, kind: "command", status: i === 4 ? ("fail" as const) : i < 5 ? ("pass" as const) : ("unknown" as const) })),
    }
    const lines = cardCompactLines(many, at, 40)
    expect(lines.length).toBeLessThanOrEqual(12)
    const joined = lines.map((l) => l.text).join("\n")
    expect(joined).toContain("✗ C5") // the failing criterion leads the focus list
    expect(joined).not.toContain("✓ C1 criterion number 1") // proven ones yield space
  })
})

describe("the tabbed panel (T056 B/E)", () => {
  test("every tab carries the tab header and the C/I/S legend footer", () => {
    for (const tab of DASHBOARD_TABS) {
      const lines = dashboardLines(view, tab, at, 60)
      const text = lines.map((l) => l.text)
      expect(text[0]).toMatch(/^◎ GOAL ⚑ needs review$/)
      expect(text[1]).toContain(tab === "now" ? "▸Now" : tab === "progress" ? "▸Progress" : tab === "decisions" ? "▸Decisions" : "▸Goals")
      // T073: the legend wraps to two lines so it never truncates
      expect(text.at(-2)).toContain("C criterion · I invariant · S plan step")
      expect(text.at(-1)).toContain("↑↓/tab/enter to act")
    }
  })

  test("NOW: hero, tracer, current step, next action, the action item, humanized events only", () => {
    const text = dashboardLines(view, "now", at, 60).map((l) => l.text).join("\n")
    expect(text).toContain("Checkout stays fast under load")
    expect(text).toContain("p95 checkout latency stays under 250ms")
    expect(text).toContain("▸ step S2 Remove the N+1 in loadCart")
    expect(text).toContain("next: re-run the 3× soak")
    expect(text).toContain("sign-off needed")
    // humanized verdicts yes, raw turn/admit noise no
    expect(text).toContain("verdict failed")
    expect(text).not.toContain("admitted")
    expect(text).not.toContain("tools=")
  })

  test("PROGRESS: plain-language criteria grouped Failed / In progress / Proven, plan and verdict", () => {
    const text = dashboardLines(view, "progress", at, 60).map((l) => l.text).join("\n")
    expect(text).toContain("Failed")
    expect(text).toContain("C C2 — p95 stays under 250ms across 3 runs (host)")
    expect(text).toContain("In progress")
    expect(text).toContain("C C3 — the fix is explained in plain language")
    expect(text).toContain("I I1 — the full suite still passes")
    expect(text).toContain("Proven")
    expect(text).toContain("C C1 — checkout tests green (host)")
    expect(text).toContain("plan")
    expect(text).toContain("S S2 ▸ Remove the N+1 in loadCart")
    expect(text).toContain("last verdict — failed")
  })

  test("DECISIONS: actionable rows exist for needs_review and are rpc.act-shaped", () => {
    const rows = decisionRows(view)
    expect(rows.length).toBeGreaterThan(0)
    const approve = rows.find((r) => r.act === "approve")
    expect(approve).toMatchObject({ arg: "C2", description: expect.stringContaining("p95") })
    expect(rows.some((r) => r.act === "reject")).toBe(true)
    const text = dashboardLines(view, "decisions", at, 60).map((l) => l.text).join("\n")
    expect(text).toContain("act on a row (↑↓ · enter)")
    expect(text).toContain("Approve C2")
  })

  test("GOALS: other goals with attachable flags and upcoming steps", () => {
    const goals = [
      { slug: "demo", title: view.title, status: "needs_review", proven: 1, total: 4 },
      { slug: "ship-v3", title: "Feedback loop", status: "running", proven: 3, total: 19, attachable: false },
      { slug: "old-thing", title: "Archived work", status: "complete", proven: 5, total: 5, terminal: true },
    ]
    const text = dashboardLines(view, "goals", at, 60, goals as any).map((l) => l.text).join("\n")
    expect(text).toContain("this goal: Checkout stays fast under load")
    expect(text).toContain("ship-v3 — Feedback loop (running)")
    expect(text).toContain("old-thing — Archived work (complete)")
    expect(text).toContain("upcoming steps")
    expect(text).toContain("S S3 · Document the change")
  })

  test("a healthy running goal shows no decision rows and a calm NOW", () => {
    const running: GoalView = { ...view, status: "running", reason: undefined, actionRequired: undefined, verdict: undefined }
    expect(decisionRows(running)).toEqual([])
    const text = dashboardLines(running, "now", at, 60).map((l) => l.text).join("\n")
    expect(text).toContain("nothing needed from you")
  })

  test("snapshots pin all four tabs", () => {
    const goals = [{ slug: "other", title: "Another goal", status: "paused", proven: 1, total: 3, attachable: true }]
    expect(DASHBOARD_TABS.map((tab) => dashboardLines(view, tab, at, 60, goals as any).map((l) => `${l.tone}|${l.bold ? "*" : ""}${l.text}`))).toMatchSnapshot()
  })

  test("humanizedEvents filters raw engine noise", () => {
    const events = humanizedEvents(view, 5)
    expect(events.map((e) => e.kind)).toEqual(["verdict", "verdict"])
    expect(humanizedEvents({ ...view, timeline: [{ t: at, kind: "admit", text: "turn 1 admitted" }] }, 5)).toEqual([])
  })

  test("T065: dialogs carry a screen-fit digest, never the full text", () => {
    const full = Array.from({ length: 50 }, (_, i) => `line ${i + 1} of the summary with some length`).join("\n")
    const digest = dialogDigest("goal complete — 21/22", full)
    const lines = digest.split("\n")
    expect(lines.length).toBeLessThanOrEqual(16) // title + 14 + pointer
    expect(lines[0]).toBe("goal complete — 21/22")
    expect(lines.at(-1)).toMatch(/\+36 more lines/)
    expect(digest).toContain("leader+g")
    // short texts pass through whole, with no truncation pointer
    const short = dialogDigest("title", "one line")
    expect(short.split("\n")).toEqual(["title", "one line"])
  })
})
