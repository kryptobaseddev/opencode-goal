// T066: decisions leave a ledger trail and sequence first at a transition.
//   - every decide() emission writes a ledger event: kind, message, choices
//     (label/act/arg) and a decisionId
//   - the next owner act on that session writes decision-resolved pairing
//     the answer to the offered decision
//   - on the wire, at needs_review, the decision event fires BEFORE the
//     summary event (the TUI renders the decision first and queues the
//     summary digest behind it — proven live by the pty gate)
import { test, expect } from "bun:test"
import { goalHost, ledger, newSession, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"
import { GoalRpc } from "../../src/rpc"

const DONE = "status: ok - ledger\n"

const REVIEW_GOAL = `schema: goal/v1
id: review
title: Needs owner sign-off
intent:
  verbatim: v
outcome: done.txt exists and the owner signs off
non_goals: [x]
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
  - id: C4
    statement: the owner signs off
    check: {kind: human, ask: "is it good?"}
plan:
  - {id: S1, title: Write done.txt, proves: [C1]}
`

test("decision ledger: emissions traced with choices; the next owner act resolves them; decision precedes summary on the wire", async () => {
  const host = await goalHost(
    script(
      (req: any, turn: { trigger: string; results: number }) => {
        if (turn.trigger.includes("goal started") || turn.trigger.includes("goal turn") || turn.trigger.includes("host verdict")) {
          if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
          if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
          if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence: { C1: "wrote done.txt", C4: "owner signs off" } } }] }
        }
        return { text: "Nothing else to do." }
      },
      () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C4", verdict: "not_proven", reason: "owner must sign off" }] } }] }),
    ),
    { ".opencode/goals/review/goal.yaml": REVIEW_GOAL },
  )
  try {
    const goalRpc = (host.client as any).rpc(GoalRpc)
    const wire: string[] = []
    goalRpc.events.on("decision", (e: any) => wire.push(`decision:${e.data?.kind}`))
    goalRpc.events.on("summary", () => wire.push("summary"))

    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start review" } as any)
    await waitStatus(host, ["needs_review"], 90000, "review")

    // --- the wire order at the transition: decision first, summary after
    const decisionIdx = wire.indexOf("decision:needs_review")
    const summaryIdx = wire.indexOf("summary")
    expect(decisionIdx).toBeGreaterThanOrEqual(0)
    expect(summaryIdx).toBeGreaterThan(decisionIdx)

    // --- the emission left a ledger trace with its choices
    const events = await ledger(host, "review")
    const decision = events.find((e) => e.type === "decision" && e.kind === "needs_review")
    expect(decision).toBeTruthy()
    expect(decision.decisionId).toMatch(/^needs_review#review@/)
    expect(decision.message).toContain("sign-off")
    const approve = decision.choices.find((c: any) => c.act === "approve")
    expect(approve).toBeTruthy()

    // --- the owner's answering act pairs with the offered decision
    const result = await goalRpc.act({ sessionID, action: "approve", arg: "C4" })
    expect(result.ok).toBe(true)
    await until(async () => (await ledger(host, "review")).some((e) => e.type === "decision-resolved"), 20000)
    const resolved = (await ledger(host, "review")).find((e) => e.type === "decision-resolved")
    expect(resolved).toMatchObject({ decision: decision.decisionId, kind: "needs_review", action: "approve" })
  } finally {
    await host.stop()
  }
}, 120000)
