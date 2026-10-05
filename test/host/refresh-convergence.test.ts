import { describe, expect, test } from "bun:test"
import { until } from "./harness"
import { goalHost, newSession, run, script, waitStatus } from "./goal.helpers"
import { GoalRpc } from "../../src/rpc"

// T072 — snapshot convergence across a server reload (the v0.3.1 completion's
// live defect: the sidebar card froze at paused/20-of-22/turn-7 while the run
// on disk had completed 22/22). Root causes fixed and proven here:
//   1. the complete transition reached disk only if summarize()'s try-block
//      survived to its last line — persist() now happens at the transition
//      itself, before the reporting layer, and pushes the final `updated`
//      event (so a live card converges even if it sees nothing else);
//   2. recover() dropped terminal goals from memory — a post-reload snapshot
//      returned null. Every goal on disk (terminal included) is now mirrored,
//      so a re-attaching TUI always reads the DISK truth.
// Scenario: start → progress mid-run → reload (recovery pauses) → snapshot
// shows the recovered paused state (disk truth) → resume → complete →
// snapshot shows complete with every criterion proven → a SECOND reload →
// the snapshot STILL shows complete — a stale paused card is unreproducible.

const DONE = "status: ok - converging\n"
const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

const worker = () => (req: any, turn: { trigger: string; results: number }) => {
  const claiming = turn.trigger.includes("resumed")
  if (turn.trigger.includes("goal started") || turn.trigger.includes("goal turn") || turn.trigger.includes("resumed")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
    if (claiming && turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  return { text: "Nothing else to do." }
}

const proven = () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states it", evidence: [{ path: "done.txt", quote: "status: ok - converging" }] }] } }] })

describe("snapshot convergence across reloads (T072)", () => {
  test("reload mid-run → resume → complete: the snapshot shows disk truth, terminal pushes, and survives a second reload", async () => {
    const host = await goalHost(script(worker(), proven))
    try {
      const sessionID = await newSession(host)
      const goalRpc = () => (host.client as any).rpc(GoalRpc)
      const updates: any[] = []
      goalRpc().events.on("updated", (event: any) => updates.push(event.data))
      const snapshot = async () => (await goalRpc().snapshot({ sessionID })).view
      const waitForView = async (pred: (view: any) => boolean, timeoutMs = 60000) =>
        until(async () => {
          const view = await snapshot()
          return pred(view) ? view : undefined
        }, timeoutMs, 500)

      // start and let the first step land: the run is live mid-run
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      await waitForView((v) => v?.status === "running" && v?.steps?.some((s: any) => s.id === "S1" && s.status === "done"))

      // ── reload mid-run (like an install/reload bounce) ──
      await host.client.location.reload()
      await until(async () => {
        try {
          await host.client.plugin.list({ location: host.location } as any)
          return true
        } catch {
          return false
        }
      }, 30000)

      // the snapshot a re-attaching TUI fetches shows the DISK truth: the
      // recovered state (paused, host restarted) — never a frozen mid-run view
      const recovered = await waitForView((v) => v?.status === "paused")
      expect(recovered.reason).toContain("host restarted")

      // ── resume → the run completes ──
      const seenBeforeResume = updates.length
      await host.client.session.command({ sessionID, name: "goal", text: "resume" } as any)
      const done = await waitStatus(host, ["complete", "needs_review", "blocked", "paused"], 120000)
      expect(done.status).toBe("complete")

      // the snapshot converges to complete with EVERY criterion proven
      const completed = await waitForView((v) => v?.status === "complete")
      expect(completed.criteria.filter((c: any) => c.status === "pass").length).toBe(completed.criteria.length)

      // the engine PUSHED a final update on the terminal transition (after
      // the reload — not only the initial attachment saw it)
      const afterReload = updates.slice(seenBeforeResume)
      expect(afterReload.some((u) => u.view?.status === "complete")).toBe(true)

      // run.json on disk agrees with the snapshot (disk truth, not memory)
      const disk = await run(host)
      expect(disk.status).toBe("complete")

      // ── a SECOND reload after completion: terminal goals stay mirrored,
      // so a re-attaching TUI still sees complete — the stale-card defect
      // has no window left ──
      await host.client.location.reload()
      await until(async () => {
        try {
          await host.client.plugin.list({ location: host.location } as any)
          return true
        } catch {
          return false
        }
      }, 30000)
      const stillComplete = await waitForView((v) => v?.status === "complete")
      expect(stillComplete.criteria.filter((c: any) => c.status === "pass").length).toBe(stillComplete.criteria.length)
    } finally {
      await host.stop()
    }
  }, 300000)
})
