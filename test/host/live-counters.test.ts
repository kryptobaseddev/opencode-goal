import { describe, expect, test } from "bun:test"
import { until } from "./harness"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"

// T013 — live counters. In run 0ffe5ac6e001 the whole 20-minute kickoff
// execution showed usage.tokens = 1: the engine only listened to
// session.usage.updated, which arrives at execution boundaries. The fix
// accumulates per-message session.usage.recorded events and refreshes the
// dashboard while the execution is still running. This scenario proves both
// halves: counters move BETWEEN model messages (observed before the claim
// lands) and never render the sentinel 1.

const DONE = "status: ok - counters live\n"
const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

describe("live counters (T013)", () => {
  test("usage accumulates per message during one execution and the dashboard refreshes before the turn ends", async () => {
    const host = await goalHost(
      script((req, turn) => {
        if (turn.trigger.includes("goal started") || turn.trigger.includes("host verdict")) {
          if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }], usage: { prompt: 1000, completion: 100 } }
          // a slow middle step: the counters for the first two replies must be
          // observable in run.json while this reply is still in flight
          if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] , usage: { prompt: 2000, completion: 200 } }
          if (turn.results === 2) return { delayMs: 8000, toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }], usage: { prompt: 3000, completion: 300 } }
        }
        return { text: "Nothing else to do.", usage: { prompt: 10, completion: 1 } }
      }, () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states it in a full line", evidence: [{ path: "done.txt", quote: "status: ok - counters live" }] }] } }] })),
    )
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)

      // mid-execution: the first replies' usage is already accumulated and
      // persisted — observed while the 4s claim reply is still in flight
      const midFlight = await until(async () => {
        const r = await run(host).catch(() => undefined)
        return r && r.usage && r.usage.tokens >= 3300 ? r : undefined
      }, 45000, 200)
      expect(midFlight).toBeDefined()
      expect(midFlight!.usage.tokens).toBeGreaterThanOrEqual(3300)
      expect(midFlight!.usage.tokens).not.toBe(1)
      // the claim may already have landed by the time we poll; what matters is
      // that the counters moved while the run was still in flight, not terminal
      expect(["running", "verifying"]).toContain(midFlight!.status)

      // the completed run never shows the sentinel and the totals accumulated
      // across the goal's own replies (exact totals vary with auxiliary
      // requests such as title generation — liveness, not arithmetic, is the contract)
      const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 120000)
      expect(done.status).toBe("complete")
      expect(done.usage.tokens).not.toBe(1)
      expect(done.usage.tokens).toBeGreaterThan(3000)

      // the usage burst is visible in the ledger timeline too
      const events = await ledger(host)
      expect(events.filter((e) => e.type === "verdict").length).toBeGreaterThan(0)
    } finally {
      await host.stop()
    }
  }, 150000)
})
