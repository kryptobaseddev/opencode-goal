import { describe, expect, test } from "bun:test"
import type { GoalView } from "../../src/rpc"
import { spinFrame, tracerLines } from "../../src/tui/tracer"

// T053 — the live activity tracer. A pure formatter renders the engine's
// working state with elapsed time and countdowns — verifying, the verifier
// child running, goal_wait countdowns, turn cooldowns — for the composer-top
// slot and the panel. Zero model cost: everything comes from the view the
// engine already persists. Snapshot-tested so the wording cannot drift.

const base: GoalView = {
  slug: "demo",
  title: "Demo file says ok",
  outcome: "done.txt exists and states that the status is ok",
  status: "running",
  runId: "r1",
  turn: 7,
  timeline: [],
  activeMs: 0,
  activeSince: null,
  usage: { tokens: 0, cost: 0 },
  budget: [],
  budgetRatio: 0,
  criteria: [],
  steps: [],
  awaitingUser: false,
  amendments: 0,
  flags: 0,
  updatedAt: 0,
}

const T0 = 1_700_000_000_000

describe("activity tracer (T053)", () => {
  test("a turn in progress ticks with elapsed time", () => {
    const view = { ...base, activity: { kind: "turn" as const, since: T0 - 45_000, detail: "continue" } }
    const lines = tracerLines(view, T0)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toContain("turn 7 in progress")
    expect(lines[0]!.text).toContain("45s")
    expect(lines[0]!.tone).toBe("success")
    expect(lines[0]!.text.startsWith(spinFrame(T0))).toBe(true)
  })

  test("verifying shows the phase; the verifier child names its model", () => {
    const verifying = tracerLines({ ...base, status: "verifying", activity: { kind: "verifying" as const, since: T0 - 8_000 } }, T0, 80)
    expect(verifying[0]!.text).toContain("verifying the claim")
    expect(verifying[0]!.text).toContain("8s")
    expect(verifying[0]!.text).toContain("verifier child")
    const child = tracerLines({ ...base, status: "verifying", activity: { kind: "verifier-child" as const, since: T0 - 23_000, detail: "fixture/test#default" } }, T0, 60)
    expect(child[0]!.text).toContain("verifier child running")
    expect(child[0]!.text).toContain("23s")
    expect(child[0]!.text).toContain("fixture/test#default")
  })

  test("T063: verifying carries live per-criterion progress instead of the static phrase", () => {
    const line = tracerLines({ ...base, status: "verifying", activity: { kind: "verifying" as const, since: T0 - 41_000, detail: "check C7 · 7/22" } }, T0, 80)
    expect(line[0]!.text).toContain("verifying the claim — 41s · check C7 · 7/22")
    expect(line[0]!.text).not.toContain("host checks, then")
  })

  test("waits and cooldowns count down to their deadline", () => {
    const waiting = tracerLines({ ...base, status: "waiting", activity: { kind: "waiting" as const, since: T0 - 10_000, until: T0 + 130_000, detail: "build running" } }, T0)
    expect(waiting[0]!.text).toContain("waiting")
    expect(waiting[0]!.text).toContain("2m 10s left")
    expect(waiting[0]!.text).toContain("build running")
    const cooldown = tracerLines({ ...base, activity: { kind: "cooldown" as const, since: T0, until: T0 + 1_500, detail: "continue" } }, T0)
    expect(cooldown[0]!.text).toContain("cooldown")
    expect(cooldown[0]!.text).toContain("next turn in 2s")
  })

  test("stopped and terminal statuses never show a stale tracer", () => {
    for (const status of ["paused", "needs_review", "blocked", "budget_limited", "complete", "aborted"] as const)
      expect(tracerLines({ ...base, status, activity: { kind: "turn" as const, since: T0 - 45_000 } }, T0)).toEqual([])
  })

  test("an active status without recorded activity still shows a pulse line", () => {
    const lines = tracerLines({ ...base }, T0)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toContain("running")
    expect(lines[0]!.text).toContain("turn 7")
  })

  test("long lines fit the composer width", () => {
    const lines = tracerLines({ ...base, activity: { kind: "verifying" as const, since: T0 - 8_000, detail: "a very long detail that would overflow a narrow composer" } }, T0, 40)
    expect(lines[0]!.text.length).toBeLessThanOrEqual(41) // 40 + the ellipsis char
  })

  test("snapshot: the tracer wording is pinned", () => {
    const views = [
      { ...base, activity: { kind: "turn" as const, since: T0 - 45_000, detail: "continue" } },
      { ...base, status: "verifying" as const, activity: { kind: "verifying" as const, since: T0 - 8_000 } },
      { ...base, status: "verifying" as const, activity: { kind: "verifier-child" as const, since: T0 - 23_000, detail: "fixture/test#default" } },
      { ...base, status: "waiting" as const, activity: { kind: "waiting" as const, since: T0 - 10_000, until: T0 + 130_000, detail: "build running" } },
      { ...base, activity: { kind: "cooldown" as const, since: T0, until: T0 + 1_500, detail: "continue" } },
    ]
    expect(views.map((v) => tracerLines(v, T0, 60).map((l) => `${l.tone}|${l.text}`))).toMatchSnapshot()
  })
})
