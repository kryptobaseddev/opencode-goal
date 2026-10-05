import { describe, expect, test } from "bun:test"
import { until } from "./harness"
import { goalHost, newSession, run, script, waitStatus } from "./goal.helpers"
import { GoalRpc } from "../../src/rpc"

// T058 — sidebar/panel refresh across state transitions. Owner report
// (2026-10-04, live): the dashboard froze at its first snapshot — stuck on
// S1, 0/22 criteria, no status changes ever rendered. The chain that must
// hold: every transition persists → persist emits `updated` → a fresh
// snapshot agrees → and the TUI re-fetches defensively so a dropped event
// stream can never freeze the card (stale-snapshot refresh + ticker, pinned
// by the unit tests in tui-refresh). This scenario drives start → progress
// → step done → pause → resume → complete and requires agreement at every
// stage.

const DONE = "status: ok - refreshing\n"
const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

const worker = () => (req: any, turn: { trigger: string; results: number }) => {
  // claim only on a post-resume turn so the scenario can pause/resume a live
  // goal deterministically (a claim on turn 1 completes before the pause stage)
  const claiming = turn.trigger.includes("resumed")
  if (turn.trigger.includes("goal started") || turn.trigger.includes("goal turn") || turn.trigger.includes("resumed")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
    if (claiming && turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  return { text: "Nothing else to do." }
}

const proven = () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states it", evidence: [{ path: "done.txt", quote: "status: ok - refreshing" }] }] } }] })

describe("view refresh across transitions (T058)", () => {
  test("every transition is visible in a fresh snapshot, and update events carry the same views", async () => {
    const host = await goalHost(script(worker(), proven))
    try {
      const goalRpc = (host.client as any).rpc(GoalRpc)
      const updates: any[] = []
      goalRpc.events.on("updated", (event: any) => updates.push(event.data))
      /** polls snapshots (the TUI's defensive path) until the view satisfies pred */
      const waitForView = async (pred: (view: any) => boolean, timeoutMs = 60000) =>
        until(async () => {
          const snap: any = await goalRpc.snapshot({ sessionID })
          return pred(snap?.view) ? snap.view : undefined
        }, timeoutMs, 500)

      const sessionID = await newSession(host)

      // start: running with S1 pending/active
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      const running = await waitForView((v) => v?.status === "running")
      expect(running.turn).toBeGreaterThanOrEqual(1)

      // work: the step completes → the snapshot carries S1 done + the progress note
      const stepped = await waitForView((v) => v?.steps?.some((s: any) => s.id === "S1" && s.status === "done"))
      expect(stepped.progress?.note).toContain("wrote done.txt")

      // pause → resume: snapshots track both
      await host.client.session.command({ sessionID, name: "goal", text: "pause" } as any)
      const paused = await waitForView((v) => v?.status === "paused", 30000)
      expect(paused.status).toBe("paused")
      await host.client.session.command({ sessionID, name: "goal", text: "resume" } as any)
      const resumed = await waitForView((v) => v?.status === "running" && v?.turn > paused.turn)
      expect(resumed.status).toBe("running")

      // complete: the snapshot carries the terminal state and proven criteria
      const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 120000)
      expect(done.status).toBe("complete")
      const completed = await waitForView((v) => v?.status === "complete", 30000)
      expect(completed.criteria.filter((c: any) => c.status === "pass").length).toBe(3)

      // the event stream (the fast path) carried the same stages: statuses
      // seen include running, paused and complete — never just the first one
      const statuses = updates.map((u) => u.view?.status).filter(Boolean)
      for (const wanted of ["running", "paused", "complete"]) expect(statuses).toContain(wanted)
      expect(updates.length).toBeGreaterThan(6)
    } finally {
      await host.stop()
    }
  }, 240000)

  test("a subscriber that joins late (like a reopened panel) sees fresh state immediately", async () => {
    const host = await goalHost(script(worker(), proven))
    try {
      const first = await newSession(host)
      await host.client.session.command({ sessionID: first, name: "goal", text: "start demo" } as any)
      // the worker never claims until a resume: the goal is live and pausable
      await waitStatus(host, ["running"], 60000)

      // a LATE subscriber gets no replayed events — the snapshot must agree
      const goalRpc = (host.client as any).rpc(GoalRpc)
      const updates: any[] = []
      goalRpc.events.on("updated", (event: any) => updates.push(event.data))
      await host.client.session.command({ sessionID: first, name: "goal", text: "pause" } as any)
      await waitStatus(host, ["paused"], 30000)
      const snap: any = await goalRpc.snapshot({ sessionID: first })
      expect(snap.view.status).toBe("paused")
      await until(() => (updates.some((u) => u.view?.status === "paused") ? true : undefined), 15000)
      expect(updates.at(-1)!.view.status).toBe(snap.view.status)
    } finally {
      await host.stop()
    }
  }, 150000)
})
