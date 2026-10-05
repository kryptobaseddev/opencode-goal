// T067: the complete decision offers more than Archive.
//   - "Start the next goal" carries a start-next rpc act that dispatches the
//     write-goal interview prompt into the session
//   - non-act choices (the CLEO guidance) stay in the payload as visible
//     guidance rows — the TUI renders them instead of dropping them
//   - the approve copy states that approving triggers verification (the
//     owner's live question at the last run's needs_review)
import { test, expect } from "bun:test"
import { goalHost, ledger, newSession, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"
import { GoalRpc } from "../../src/rpc"

const DONE = "status: ok - complete\n"

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

test("complete decision: start-next dispatches the interview, guidance choices ride the payload, approve copy states verify", async () => {
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
    const decisions: any[] = []
    goalRpc.events.on("decision", (event: any) => decisions.push(event.data))

    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start review" } as any)
    await waitStatus(host, ["needs_review"], 90000, "review")

    // --- the approve copy states that approving triggers verification
    const signOff = await until(() => decisions.find((d) => d.kind === "needs_review"), 10000)
    expect(signOff.message).toMatch(/Approve runs verification/i)
    await goalRpc.act({ sessionID, action: "approve", arg: "C4" })
    await waitStatus(host, ["complete"], 90000, "review")

    // --- the complete decision: more than Archive
    const complete = await until(() => decisions.find((d) => d.kind === "complete"), 10000)
    const startNext = complete.choices.find((c: any) => c.act === "start-next")
    expect(startNext).toBeTruthy()
    expect(complete.choices.some((c: any) => c.act === "archive")).toBe(true)
    // the guidance row is still in the payload (the TUI renders it as a row)
    expect(complete.choices.some((c: any) => !c.act && /CLEO/i.test(c.run ?? c.label))).toBe(true)

    // --- dispatching start-next lands the write-goal interview prompt here
    const promptsBefore = host.fixture.requests.length
    const result = await goalRpc.act({ sessionID, action: "start-next" })
    expect(result.ok).toBe(true)
    await until(async () => host.fixture.requests.length > promptsBefore, 30000)
    const interviewRequest = host.fixture.requests.at(-1)!
    expect(JSON.stringify(interviewRequest.messages)).toMatch(/next goal|write-goal|interview/i)

    // the resolution is ledgered (T066 pairing)
    await until(async () => (await ledger(host, "review")).some((e) => e.type === "decision-resolved" && e.action === "start-next"), 20000)
  } finally {
    await host.stop()
  }
}, 150000)
