import { describe, expect, test } from "bun:test"
import { until } from "./harness"
import { goalHost, newSession, run, script, waitStatus } from "./goal.helpers"
import { GoalRpc } from "../../src/rpc"

// T069 — deferred /goal commands acknowledge themselves. The live defect
// (v0.3.1 completion): "/goal commands queue silently behind an active turn —
// I sent it but nothing happened". Proven here end-to-end:
//   1. a /goal command issued mid-turn acknowledges IMMEDIATELY (a notice,
//      not silence) and does NOT execute early;
//   2. read/control commands (status, pause) still execute immediately;
//   3. the deferred command executes the moment the turn ends;
//   4. the same holds behind an open form: ack on send, execute on reply.

const DONE = "status: ok - ack\n"

describe("deferred command acknowledgment (T069)", () => {
  test("mid-turn commands ack instantly, run at turn end; same behind a form", async () => {
    const host = await goalHost(
      script((req, turn) => {
        if (turn.trigger.includes("HOLDTURN") && turn.results === 0) {
          return { toolCalls: [{ name: "write", args: { path: "held.txt", content: "held\n" } }], delayMs: 12000 }
        }
        if (turn.trigger.includes("goal started") || turn.trigger.includes("goal turn") || turn.trigger.includes("resumed")) {
          if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
          if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "hold" } }] }
        }
        return { text: "Nothing else to do." }
      }),
    )
    try {
      const sessionID = await newSession(host)
      const goalRpc = (host.client as any).rpc(GoalRpc)
      const notices: any[] = []
      goalRpc.events.on("notice", (event: any) => notices.push(event.data))

      // ── 1. mid-turn: the command acknowledges instantly, executes never ──
      await host.client.session.prompt({ sessionID, text: "HOLDTURN please" } as any)
      // the turn is REALLY running when its request hit the fixture (the
      // write tool's 12s delay keeps the session busy past the assertions)
      await until(
        async () => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("HOLDTURN") && r.tools?.length),
        30000,
        100,
      )
      const sentAt = Date.now()
      void host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      const ack = await until(async () => notices.find((n) => n.text.includes("acknowledged") && n.text.includes("/goal start")), 5000, 50)
      expect(ack).toBeDefined()
      expect(Date.now() - sentAt).toBeLessThan(4000) // instant: well before the 6s turn ends
      expect(ack.text).toContain("queued")
      // and it did NOT run early: no run.json exists while the turn holds
      const premature = await run(host).catch(() => undefined)
      expect(premature).toBeUndefined()

      // ── 2. a read command stays immediate even mid-turn ──
      notices.length = 0
      void host.client.session.command({ sessionID, name: "goal", text: "status" } as any)
      const statusNotice = await until(async () => notices.find((n) => /no goal in this session|demo/i.test(String(n.text))), 4000, 50)
      expect(statusNotice).toBeDefined()
      expect(String(statusNotice.text)).not.toContain("acknowledged — queued")

      // ── 3. the turn ends → the deferred start executes ──
      const started = await waitStatus(host, ["running"], 60000)
      expect(started.sessionID).toBe(sessionID)

      // ── 4. behind an open form: ack on send, execute on reply ──
      await host.client.session.command({ sessionID, name: "goal", text: "pause" } as any)
      await waitStatus(host, ["paused"], 30000)
      // the kickoff turn the flushed start launched may still be draining —
      // wait for the session to go IDLE (last execution event = end) so the
      // next deferral is attributable to the FORM, not a busy turn
      let lastExecutionEnd = 0
      let executionSeen = 0
      const watch = async () => {
        try {
          for await (const e of (host.client as any).event.subscribe({}) as AsyncIterable<any>) {
            if (!e.data?.sessionID || e.data.sessionID !== sessionID) continue
            if (e.type === "session.execution.started") executionSeen = Date.now()
            if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(e.type)) lastExecutionEnd = Date.now()
          }
        } catch {
          /* stream teardown noise */
        }
      }
      void watch()
      await until(async () => lastExecutionEnd > 0 && Date.now() - Math.max(lastExecutionEnd, executionSeen) > 700, 30000, 200)
      const form = await (host.client.session.form as any).create({
        sessionID,
        title: "Unrelated question holding the session",
        fields: [{ key: "q0", type: "string" as const, custom: true, options: [{ value: "ok", label: "ok" }] }],
      })
      // the create response can beat the plugin's form.created handling —
      // wait until the ENGINE sees the form (awaitingUser) before commanding
      await until(async () => (await goalRpc.snapshot({ sessionID }))?.view?.awaitingUser === true, 10000, 100)
      notices.length = 0
      void host.client.session.command({ sessionID, name: "goal", text: "resume" } as any)
      const formAck = await until(async () => notices.find((n) => n.text.includes("acknowledged") && n.text.includes("/goal resume") && n.text.includes("form")), 15000, 50)
      expect(formAck).toBeDefined()
      await Bun.sleep(500)
      // still paused: the form holds the queue
      const stillPaused = await run(host)
      expect(stillPaused.status).toBe("paused")
      await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: { q0: "ok" } })
      const resumed = await waitStatus(host, ["running"], 90000)
      expect(resumed.status).toBe("running")
    } finally {
      await host.stop()
    }
  }, 180000)
})
