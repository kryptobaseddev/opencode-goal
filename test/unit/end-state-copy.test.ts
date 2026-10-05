import { describe, expect, test } from "bun:test"
import type { Contract } from "../../src/contract/types"
import { initialRun } from "../../src/engine/state"
import { bannerText } from "../../src/tui/format"
import { cardCompactLines, cardExpandedLines, dialogDigest } from "../../src/tui/dashboard"
import { buildPostGoalSummary } from "../../src/summary/build"
import { M } from "../../src/server/messages"
import type { GoalView } from "../../src/rpc"

// T071 — end-state copy. The v0.3.1 completion read as broken because
// nothing said the loop had stopped. Pinned here: at complete / failed /
// aborted the CARD, the BANNER above the composer and the SUMMARY DIGEST all
// state that the loop has stopped and where the follow-ups live.

const contract = {
  schema: "goal/v1",
  id: "demo",
  title: "Demo file says ok",
  intent: { verbatim: "v" },
  why: "w",
  outcome: "done.txt exists and states that the status is ok",
  non_goals: ["Relay mode"],
  scope: { in: [], out: [] },
  criteria: [
    { id: "C1", statement: "done.txt SHALL exist", essential: true, check: { kind: "file" as const, path: "done.txt" } },
    { id: "C2", statement: "done.txt contains the ok line", essential: true, check: { kind: "command" as const, run: "grep -q ok done.txt" } },
  ],
  invariants: [],
  protect: [],
  plan: [{ id: "S1", title: "Write done.txt", proves: ["C1"] }],
  autonomy: { questions: "defer" as const, on_user_message: "steer" as const, on_interrupt: "pause" as const },
  verification: { mode: "host" as const, max_rejections: 3 },
  stop: [],
  budget: {},
  constraints: [],
  assumptions: [],
} as unknown as Contract

const state = initialRun(contract, { sessionID: "ses_x", runId: "r1", lock: "l", now: 1 })
state.turn = 4

const viewOf = (status: string): GoalView =>
  ({
    slug: "demo",
    title: contract.title,
    outcome: contract.outcome,
    status,
    runId: "r1",
    turn: 4,
    timeline: [],
    activeMs: 60000,
    activeSince: null,
    usage: { tokens: 1000, cost: 0.1 },
    budget: [],
    budgetRatio: 0.1,
    criteria: [
      { id: "C1", statement: "done.txt SHALL exist", essential: true, invariant: false, kind: "file", status: "pass", by: "host" },
      { id: "C2", statement: "done.txt contains the ok line", essential: true, invariant: false, kind: "command", status: "pass", by: "host" },
    ],
    steps: [{ id: "S1", title: "Write done.txt", status: "done" }],
    awaitingUser: false,
    amendments: 0,
    flags: 0,
    updatedAt: 1,
  }) as unknown as GoalView

describe("end-state copy (T071)", () => {
  test("every terminal status has stopped+follow-ups copy in banner, card and expanded card", () => {
    for (const status of ["complete", "failed", "aborted"]) {
      const view = viewOf(status)
      const banner = bannerText(view)
      expect(banner).toBeDefined()
      expect(banner!.text.toLowerCase()).toContain("stopped")
      expect(banner!.text).toContain(".opencode/goals/demo/")

      const compact = cardCompactLines(view, 1, 60).map((l) => l.text).join("\n")
      expect(compact.toLowerCase()).toContain("stopped")
      expect(compact).toContain(".opencode/goals/demo/")

      const expanded = cardExpandedLines(view, 1, 60).map((l) => l.text).join("\n")
      expect(expanded.toLowerCase()).toContain("stopped")
    }
    // a live goal never claims the loop stopped
    const running = bannerText(viewOf("running"))
    expect(running === undefined || !/stopped/i.test(running.text)).toBe(true)
    expect(cardCompactLines(viewOf("running"), 1, 60).map((l) => l.text).join("\n").toLowerCase()).not.toContain("stopped")
  })

  test("the post-goal summary states the loop stopped and names where follow-ups live", () => {
    for (const status of ["complete", "needs_review", "budget_limited"]) {
      state.status = status as typeof state.status
      const summary = buildPostGoalSummary({ contract, state })
      expect(summary.text).toContain("The loop has stopped")
      expect(summary.text).toContain(`.opencode/goals/${state.slug}/`)
      expect(summary.text).toContain("Follow-ups")
      // the digest the TUI dialog shows keeps the stopped line within its
      // screen-fit budget (it sits near the top)
      const digest = dialogDigest(summary.headline, summary.text)
      expect(digest).toContain("The loop has stopped")
      expect(digest).toContain(`.opencode/goals/${state.slug}/`)
    }
    state.status = "complete"
  })

  test("the engine's complete notices also say the loop stopped", () => {
    expect(M.complete("t", 0).text.toLowerCase()).toContain("stopped")
    expect(M.goalSummary("h", 0, "complete").text.toLowerCase()).toContain("stopped")
  })
})
