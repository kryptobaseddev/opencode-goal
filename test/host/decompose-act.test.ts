import { describe, expect, test } from "bun:test"
import { until } from "./harness"
import { goalHost, ledger, newSession, script, waitStatus } from "./goal.helpers"
import { GoalRpc } from "../../src/rpc"

// T070 — guidance acts. The v0.3.1 completion's live defect: picking
// "Decompose with CLEO" at the complete decision did nothing but toast.
// Proven here end-to-end:
//   1. the complete decision's "Decompose with CLEO" carries a real
//      rpc act ("decompose");
//   2. choices WITHOUT an act are marked guidance:true in the payload (the
//      dialog copy says guidance, not button);
//   3. dispatching the act lands the CLEO decomposition prompt in the session
//      (the fixture sees the CLEO-DECOMPOSE trigger) and records it in the
//      ledger.

const DONE = "status: ok - decompose\n"
const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

const worker = () => (req: any, turn: { trigger: string; results: number }) => {
  if (turn.trigger.includes("goal started") || turn.trigger.includes("goal turn")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  return { text: "Nothing else to do." }
}

const proven = () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states it", evidence: [{ path: "done.txt", quote: "status: ok - decompose" }] }] } }] })

describe("the decompose act (T070)", () => {
  test("complete decision offers Decompose as an act, guidance rows are marked, and the act dispatches the CLEO prompt", async () => {
    // .cleo/project-context.json makes the project CLEO-linked (config
    // source), so the complete decision offers the act-able Decompose row
    const host = await goalHost(script(worker(), proven), {
      ".cleo/project-context.json": JSON.stringify({ schemaVersion: "1.0.0", projectTypes: ["unknown"] }),
    })
    try {
      const sessionID = await newSession(host)
      const goalRpc = (host.client as any).rpc(GoalRpc)
      const decisions: any[] = []
      goalRpc.events.on("decision", (event: any) => decisions.push(event.data))

      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      const done = await waitStatus(host, ["complete", "needs_review", "blocked", "paused"], 120000)
      expect(done.status).toBe("complete")

      // ── 1. the complete decision carries the decompose ACT ──
      const completeDecision = await until(async () => decisions.find((d) => d.kind === "complete"), 15000)
      expect(completeDecision).toBeDefined()
      const choices = completeDecision.choices as Array<{ label: string; act?: string; guidance?: boolean }>
      const decompose = choices.find((c) => c.label.includes("Decompose"))
      expect(decompose).toBeDefined()
      expect(decompose!.act).toBe("decompose")

      // ── 2. guidance-only rows are marked in the payload itself ──
      expect(choices.filter((c) => !c.act).every((c) => c.guidance === true)).toBe(true)
      expect(choices.filter((c) => c.act).every((c) => c.guidance === undefined)).toBe(true)

      // ── 3. dispatching the act lands the CLEO decomposition prompt ──
      const before = host.fixture.requests.length
      const result = await goalRpc.act({ sessionID, action: "decompose" })
      expect(result.ok).toBe(true)
      await until(
        async () =>
          host.fixture.requests
            .slice(before)
            .some((r) => JSON.stringify(r.messages).includes("CLEO-DECOMPOSE")),
        30000,
      )
      // and the dispatch is on the record
      const entries = await ledger(host)
      expect(entries.some((e) => e.type === "decompose-dispatched")).toBe(true)
    } finally {
      await host.stop()
    }
  }, 180000)
})
