import { describe, expect, test } from "bun:test"
import type { GoalView } from "../../src/rpc"
import { cardAffordanceTab, cardCompactLines, cardExpandedLines, dashboardLines, wrap } from "../../src/tui/dashboard"

// T073 — card readability (the v0.3.1 completion's live defect: rows cut off
// with no way to expand). Pinned here:
//   1. the compact card KEEPS its 12-line cap but always ends with an
//      explicit expand affordance naming where the full rows live;
//   2. truncated rows carry a `tab` click-through target — the matching
//      panel tab holds their full text;
//   3. the expanded view (the panel) renders every row FULLY at any width:
//      statements wrap, never `…`;
//   4. compact and expanded rendering are snapshot-tested.

const at = 1_700_000_000_000

const view: GoalView = {
  slug: "demo",
  title: "Checkout stays fast under load",
  outcome: "p95 checkout latency stays under 250ms at 3× traffic",
  status: "needs_review",
  reason: "C2 rejected 3 times",
  runId: "r1",
  turn: 9,
  timeline: [{ t: at - 45_000, kind: "verdict", text: "verdict failed — C2 rejected 3 times" }],
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
    { id: "C2", statement: "p95 stays under 250ms across 3 soak runs of the full checkout path", essential: true, invariant: false, kind: "command", status: "fail", by: "host", detail: "p95 312ms (run 2/3)" },
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

const render = (lines: { text: string }[]) => lines.map((l) => l.text).join("\n")

describe("card readability (T073)", () => {
  test("wrap: long text becomes full-width lines, never an ellipsis", () => {
    const parts = wrap("p95 stays under 250ms across 3 soak runs of the full checkout path", 30)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(30)
    expect(parts.join(" ")).toBe("p95 stays under 250ms across 3 soak runs of the full checkout path")
    expect(parts.some((p) => p.includes("…"))).toBe(false)
    expect(wrap("short", 30)).toEqual(["short"])
    expect(wrap("supercalifragilisticexpialidocious-and-then-some-more", 10).join("")).toBe("supercalifragilisticexpialidocious-and-then-some-more")
  })

  test("the compact card keeps its cap and always ends with the expand affordance", () => {
    for (const width of [30, 40, 60, 80]) {
      const lines = cardCompactLines(view, at, width)
      expect(lines.length).toBeLessThanOrEqual(12)
      const affordance = lines.at(-1)!
      expect(affordance.text).toMatch(/^↳ /)
      expect(affordance.text).toContain("leader+g")
      for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(width + 1)
    }
  })

  test("truncated rows carry a click-through tab; the affordance targets it", () => {
    // narrow sidebar: the action-required line and criteria truncate
    const narrow = cardCompactLines(view, at, 30)
    const truncated = narrow.filter((l) => l.text.includes("…") && l.tab)
    expect(truncated.length).toBeGreaterThan(0)
    expect(truncated.every((l) => ["now", "progress", "decisions"].includes(l.tab!))).toBe(true)
    // a truncation exists ⇒ the affordance names the tab it lands on
    expect(narrow.at(-1)!.text).toMatch(/→ (Now|Progress|Decisions)/)
    // decisions-class truncation outranks criteria
    expect(cardAffordanceTab(view, at, 30)).toBe("decisions")
    // wide enough: nothing truncates, no click-through needed
    const wide = cardCompactLines(view, at, 120)
    expect(wide.some((l) => l.text.includes("…"))).toBe(false)
    expect(cardAffordanceTab(view, at, 120)).toBeUndefined()
    expect(wide.at(-1)!.text).toContain("full card")
  })

  test("the click-through target holds the FULL text the card cut off", () => {
    const narrow = cardCompactLines(view, at, 30)
    const cut = narrow.find((l) => l.tab === "progress" && l.text.includes("…"))!
    expect(cut.text).not.toContain("soak runs of the full checkout path")
    // the matching panel tab renders the statement fully (wrapped, no …)
    const progress = render(dashboardLines(view, "progress", at, 46))
    expect(progress).toContain("p95 stays under 250ms across 3 soak runs")
    expect(progress).toContain("of the full checkout path")
    expect(progress).not.toContain("…")
  })

  test("the expanded view renders every row fully at any width", () => {
    for (const width of [24, 40, 60, 100]) {
      const lines = cardExpandedLines(view, at, width)
      const text = render(lines)
      expect(text).not.toContain("…")
      // every criterion statement appears in full (as wrapped fragments)
      for (const c of view.criteria) {
        const words = c.statement.split(" ")
        for (const w of words) expect(text).toContain(w)
      }
      expect(text).toContain(view.title)
      expect(text).toContain("plan")
      expect(text).toContain("last verdict — failed")
      // the plan is complete: every step, not just the active one
      for (const s of view.steps) expect(text).toContain(s.title)
    }
  })

  test("compact and expanded rendering are snapshot-tested", () => {
    expect(cardCompactLines(view, at, 40)).toMatchSnapshot("compact-40")
    expect(cardCompactLines(view, at, 60)).toMatchSnapshot("compact-60")
    expect(cardExpandedLines(view, at, 46)).toMatchSnapshot("expanded-46")
    expect(cardExpandedLines(view, at, 80)).toMatchSnapshot("expanded-80")
  })
})
