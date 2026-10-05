import { describe, expect, test } from "bun:test"
import { until } from "./harness"
import { goalHost, newSession, run, script, waitStatus } from "./goal.helpers"
import { GoalRpc } from "../../src/rpc"

// T052 — persistent terminal feedback. Verdicts, owner actions, amendments,
// blocks and completions land as TRANSCRIPT NOTICE ROWS (session.synthetic)
// the agent sees next turn — asserted directly on the session's message list,
// which is exactly what the next model request renders — and an
// action-required state rides the sidebar view (rpc.snapshot) until the
// status resolves.

const DONE = "status: ok - persistent\n"
const demoEvidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }
const reviewEvidence = { C1: "wrote done.txt", C4: "the owner should sign off" }

const worker = (evidence: Record<string, string> = demoEvidence) => (req: any, turn: { trigger: string; results: number }) => {
  if (turn.trigger.includes("goal started") || turn.trigger.includes("goal turn") || turn.trigger.includes("host verdict")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  return { text: "Nothing else to do." }
}

const notProven = () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "not_proven", reason: "cannot confirm from here" }] } }] })
const proven = () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states it", evidence: [{ path: "done.txt", quote: "status: ok - persistent" }] }] } }] })

/** The transcript rows the session carries — what the agent's next turn renders. */
const transcriptRows = async (host: Awaited<ReturnType<typeof goalHost>>, sessionID: string) => {
  const messages: any[] = ((await (host.client as any).session.context({ sessionID }).catch(() => [])) ?? []) as any[]
  return messages.map((m) => `${m.text ?? ""}`).join("\n")
}

describe("persistent feedback (T052)", () => {
  test("a rejected claim leaves a HOST VERDICT transcript row the agent sees next turn; completion leaves the summary row", async () => {
    let round = 0
    const host = await goalHost(
      script(worker(), () => {
        round++
        return round === 1 ? notProven() : proven()
      }),
    )
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      // the first claim is rejected (verifier says not_proven) → verdict row
      await until(async () => ((await transcriptRows(host, sessionID)).includes("HOST VERDICT") ? true : undefined), 60000)
      const rows = await transcriptRows(host, sessionID)
      expect(rows).toContain("Fix the failed criteria")
      expect(rows).toContain("C3 FAILED")

      // completing later leaves the persistent summary row — queued in the
      // session inbox, delivered on the session's next turn (a real prompt)
      const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000)
      expect(done.status).toBe("complete")
      await (host.client as any).session.prompt({ sessionID, text: "wrap up: report the outcome in one line" } as any)
      await until(async () => ((await transcriptRows(host, sessionID)).includes("goal.summary") ? true : undefined), 60000)
      const finalRows = await transcriptRows(host, sessionID)
      expect(finalRows).toContain("Goal complete")
      expect(finalRows).toContain("goal.summary")
    } finally {
      await host.stop()
    }
  }, 150000)

  test("an OWNER action from a second session leaves its transcript note in the goal's session; the sidebar view carries action-required until resolved", async () => {
    const host = await goalHost(
      script(worker(reviewEvidence), notProven),
      {
        ".opencode/goals/review/goal.yaml": `schema: goal/v1
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
`,
      },
    )
    try {
      const goalRpc = (host.client as any).rpc(GoalRpc)
      const workerSession = await newSession(host)
      await host.client.session.command({ sessionID: workerSession, name: "goal", text: "start review" } as any)
      await waitStatus(host, ["needs_review"], 90000, "review")

      // the sidebar view (what the card renders from) carries action-required
      const view1: any = await goalRpc.snapshot({ sessionID: workerSession })
      expect(view1?.view?.actionRequired).toContain("sign-off")
      // …and it PERSISTS: a second snapshot later still shows it
      await Bun.sleep(700)
      const view2: any = await goalRpc.snapshot({ sessionID: workerSession })
      expect(view2?.view?.actionRequired).toBe(view1?.view?.actionRequired)

      // the OWNER acts from a SECOND session (T049 fallback); the note lands
      // in the goal's own session, delivered on its next turn
      const ownerSession = await newSession(host)
      await host.client.session.command({ sessionID: ownerSession, name: "goal", text: "approve C4" } as any)
      await until(async () => (((await run(host, "review")).criteria.C4?.status === "pass" ? true : undefined)), 15000)
      // the goal completed on the approval; its queued rows deliver on the session's next turn
      await (host.client as any).session.prompt({ sessionID: workerSession, text: "the owner acted — report what changed in one line" } as any)
      await until(async () => ((await transcriptRows(host, workerSession)).includes("owner approved C4") ? true : undefined), 60000)
      const rows = await transcriptRows(host, workerSession)
      expect(rows).toContain("final — never re-checked")

      // once resolved, the action-required state is gone
      const view3: any = await goalRpc.snapshot({ sessionID: workerSession })
      expect(view3?.view?.actionRequired ?? "").not.toContain("sign-off")
      expect((await run(host, "review")).status).toBe("complete")
    } finally {
      await host.stop()
    }
  }, 150000)
})
