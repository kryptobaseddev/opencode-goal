import { describe, expect, test } from "bun:test"
import { until } from "./harness"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { GoalRpc } from "../../src/rpc"

// T049 — goals escape their session. Runs are keyed by the session that
// started the goal, so a fresh session saw zero palette entries and
// /goal approve answered "No goal in this session". Fix pinned here:
// owner actions fall back to the project's unique non-terminal goal from
// any session (or the slug the owner names), /goal attach moves a stopped
// goal into the current session, and the RPC list carries attachable flags
// the palette uses to offer selectable goals.

const DONE = "status: ok - any session\n"
const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

const worker = (req: any, turn: { trigger: string; results: number }) => {
  if (turn.trigger.includes("goal started") || turn.trigger.includes("host verdict") || turn.trigger.includes("resumed")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  return { text: "Nothing else to do." }
}

const notProven = () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "not_proven", reason: "not yet checked from here" }] } }] })
const proven = () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states the status in a full line", evidence: [{ path: "done.txt", quote: "status: ok - any session" }] }] } }] })

describe("session fallback (T049)", () => {
  test("the owner pauses, approves, attaches and resumes the goal from a second session; the loop continues there", async () => {
    let round = 0
    const host = await goalHost(
      script(worker, () => {
        round++
        return round === 1 ? notProven() : proven()
      }),
    )
    try {
      const goalRpc = (host.client as any).rpc(GoalRpc)
      const first = await newSession(host)
      await host.client.session.command({ sessionID: first, name: "goal", text: "start demo" } as any)
      // the first verify fails on the verifier's not_proven → the goal keeps running
      await waitStatus(host, ["running", "paused", "needs_review", "blocked", "complete"], 60000)
      expect((await run(host)).turn).toBeGreaterThanOrEqual(1)

      // ── a SECOND session, with no goal of its own ──
      const second = await newSession(host)

      // pause via fallback: unique non-terminal goal, no slug needed
      await host.client.session.command({ sessionID: second, name: "goal", text: "pause" } as any)
      const paused = await waitStatus(host, ["paused"], 30000)
      expect(paused.status).toBe("paused")

      // approve a criterion by id only (unique-goal fallback) — and by id + slug
      await host.client.session.command({ sessionID: second, name: "goal", text: "approve C3" } as any)
      const approved = await until(async () => (((await run(host)).criteria.C3?.status === "pass" ? (await run(host)) : undefined)), 15000)
      expect(approved.criteria.C3).toMatchObject({ status: "pass", by: "human" })

      // attach: the goal moves into the second session
      await host.client.session.command({ sessionID: second, name: "goal", text: "attach demo" } as any)
      const attached = await until(async () => (((await run(host)).sessionID === second ? (await run(host)) : undefined)), 15000)
      expect(attached.status).toBe("paused")
      const events = await ledger(host)
      expect(events.some((e) => e.type === "attached" && e.to === second && e.from === first)).toBe(true)

      // the RPC list marks the goal attachable (live + stopped) for palettes
      const listed: any = await goalRpc.list({})
      const demo = listed?.goals?.find((g: any) => g.slug === "demo")
      expect(demo?.attachable).toBe(true)

      // resume from the second session: the continuation is admitted THERE and completes
      await host.client.session.command({ sessionID: second, name: "goal", text: "resume" } as any)
      const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000)
      expect(done.status).toBe("complete")
      expect(done.sessionID).toBe(second)
      // C3 stayed owner-final across the resumed run's verification
      expect(done.criteria.C3).toMatchObject({ status: "pass", by: "human" })
      expect(done.criteria.C1).toMatchObject({ status: "pass", by: "host" })
    } finally {
      await host.stop()
    }
  }, 150000)

  test("with several live goals the fallback refuses; naming one acts on it; the list flags attachables", async () => {
    // no claims here: both goals just idle in running until their owners pause them,
    // so two live (paused) goals exist when the third session acts
    const idler = (req: any, turn: { trigger: string; results: number }) => {
      if (turn.trigger.includes("goal started") && turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
      return { text: "Nothing else to do." }
    }
    const host = await goalHost(script(idler, notProven), {
      ".opencode/goals/second/goal.yaml": DEMO_GOAL.replace("id: demo", "id: second").replace("title: Demo file says ok", "title: Second demo"),
    })
    try {
      const goalRpc = (host.client as any).rpc(GoalRpc)

      const first = await newSession(host)
      await host.client.session.command({ sessionID: first, name: "goal", text: "start demo" } as any)
      const other = await newSession(host)
      await host.client.session.command({ sessionID: other, name: "goal", text: "start second" } as any)
      await waitStatus(host, ["running"], 30000, "second")
      // park both goals from their own sessions: two live, stopped goals
      await host.client.session.command({ sessionID: first, name: "goal", text: "pause" } as any)
      await host.client.session.command({ sessionID: other, name: "goal", text: "pause" } as any)
      await waitStatus(host, ["paused"], 30000)
      await waitStatus(host, ["paused"], 30000, "second")

      // two live goals → an approve from a goal-less third session is refused (ambiguous, no slug)
      const third = await newSession(host)
      await host.client.session.command({ sessionID: third, name: "goal", text: "approve C1" } as any)
      await Bun.sleep(1500)
      expect((await run(host, "demo")).criteria.C1?.status ?? "unknown").not.toBe("pass")
      expect((await run(host, "second")).criteria.C1?.status ?? "unknown").not.toBe("pass")

      // …while naming one acts on exactly that goal
      await host.client.session.command({ sessionID: third, name: "goal", text: "approve C1 second" } as any)
      const approved = await until(async () => (((await run(host, "second")).criteria.C1?.status === "pass" ? (await run(host, "second")) : undefined)), 15000)
      expect(approved.criteria.C1).toMatchObject({ status: "pass", by: "human" })
      expect((await run(host, "demo")).criteria.C1?.status ?? "unknown").not.toBe("pass")

      // the list marks the stopped goals attachable
      const listed: any = await goalRpc.list({})
      expect(listed?.goals?.find((g: any) => g.slug === "second")?.attachable).toBe(true)
      expect(listed?.goals?.find((g: any) => g.slug === "demo")?.attachable).toBe(true)
    } finally {
      await host.stop()
    }
  }, 150000)
})
