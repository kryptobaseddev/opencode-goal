import { describe, expect, test } from "bun:test"
import { until } from "./harness"
import { goalHost, newSession, run, script, waitStatus } from "./goal.helpers"
import { GoalRpc } from "../../src/rpc"

// T050 — decision dialogs at every decision point. The engine emits a
// decision payload (rpc "decision" event with kind + message + structured
// choices) at needs_review, paused-after-verdict, blocked, budget_limited,
// amend-proposed, supersede-ack and complete; the TUI renders it as a
// selectable dialog wired to rpc.act. This scenario drives decisions
// end-to-end through the payload's own choices: rpc.act(choice.act,
// choice.arg) IS the dialog's wiring.

const DONE = "status: ok - decisions\n"

const worker = (evidence: Record<string, string>) => (req: any, turn: { trigger: string; results: number }) => {
  if (turn.trigger.includes("goal started") || turn.trigger.includes("goal turn") || turn.trigger.includes("host verdict")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  return { text: "Nothing else to do." }
}

const verifierProven = () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states it", evidence: [{ path: "done.txt", quote: "status: ok - decisions" }] }] } }] })

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

const BUDGET_GOAL = `schema: goal/v1
id: onabudget
title: Runs out of budget
intent:
  verbatim: v
outcome: done.txt exists
non_goals: [x]
budget:
  turns: 2
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
plan:
  - {id: S1, title: Write done.txt, proves: [C1]}
`

/** Blocks once per turn; the third block trip sets status blocked. */
const blockerWorker = () => (req: any, turn: { trigger: string; results: number }) => {
  if (turn.results === 0) return { toolCalls: [{ name: "goal_block", args: { key: "missing-credential", reason: "the deploy token (DEPLOY_TOKEN) is absent", needs: "credential" } }] }
  return { text: "Still blocked; nothing else to do." }
}

const BLOCK_GOAL = `schema: goal/v1
id: blocky
title: Blocks on a credential
intent:
  verbatim: v
outcome: done.txt exists
non_goals: [x]
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
plan:
  - {id: S1, title: Write done.txt, proves: [C1]}
`

describe("decision dialogs (T050)", () => {
  test("needs_review → dialog choice approve drives rpc.act end-to-end; complete follows with its own decision", async () => {
    const host = await goalHost(script(worker({ C1: "wrote done.txt", C4: "the owner should sign off" }), verifierProven), {
      ".opencode/goals/review/goal.yaml": REVIEW_GOAL,
    })
    try {
      const goalRpc = (host.client as any).rpc(GoalRpc)
      const decisions: any[] = []
      const off = goalRpc.events.on("decision", (event: any) => decisions.push(event.data))

      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start review" } as any)
      await waitStatus(host, ["needs_review"], 90000, "review")

      // the needs_review decision carries structured, act-able choices
      const review = await until(() => decisions.find((d) => d.kind === "needs_review" && d.slug === "review"), 10000)
      expect(review.message).toContain("sign-off")
      const approve = review.choices.find((c: any) => c.act === "approve")
      expect(approve).toMatchObject({ label: expect.any(String), act: "approve" })
      expect(review.choices.some((c: any) => c.act === "reject")).toBe(true)

      // THE DIALOG WIRING: picking the choice is rpc.act(act, arg)
      const acted = await goalRpc.act({ sessionID, action: approve.act, ...(approve.arg ? { arg: approve.arg } : {}) })
      expect(acted.ok).toBe(true)
      const done = await waitStatus(host, ["complete", "paused", "blocked"], 60000, "review")
      expect(done.status).toBe("complete")
      expect(done.criteria.C4).toMatchObject({ status: "pass", by: "human" })

      // completion carries its own decision with archive/new-goal choices
      const complete = await until(() => decisions.find((d) => d.kind === "complete" && d.slug === "review"), 10000)
      expect(complete.choices.some((c: any) => c.act === "archive")).toBe(true)
      expect(complete.message).toContain("What next?")
      off?.()
    } finally {
      await host.stop()
    }
  }, 150000)

  test("budget_limited, supersede-ack and amend-proposed each emit their decision payload", async () => {
    const host = await goalHost(
      script(() => ({ text: "Working on it." })),
      {
        ".opencode/goals/onabudget/goal.yaml": BUDGET_GOAL,
        ".opencode/goals/superseder/goal.yaml": "schema: goal/v1\nid: superseder\ntitle: Supersedes the live goal\nsupersedes: onabudget@placeholder\nintent:\n  verbatim: v\noutcome: done.txt exists\nnon_goals: [x]\ncriteria:\n  - id: C1\n    statement: done.txt SHALL exist\n    check: {kind: file, path: done.txt}\nplan:\n  - {id: S1, title: Write done.txt, proves: [C1]}\n",
      },
    )
    try {
      const goalRpc = (host.client as any).rpc(GoalRpc)
      const decisions: any[] = []
      const off = goalRpc.events.on("decision", (event: any) => decisions.push(event.data))
      const sessionID = await newSession(host)

      // budget_limited: the two-turn budget wraps up and stops
      await host.client.session.command({ sessionID, name: "goal", text: "start onabudget" } as any)
      await waitStatus(host, ["budget_limited"], 90000, "onabudget")
      const budget = await until(() => decisions.find((d) => d.kind === "budget_limited"), 10000)
      expect(budget.slug).toBe("onabudget")
      expect(budget.choices.some((c: any) => c.run.includes("budget"))).toBe(true)
      expect(budget.choices.some((c: any) => c.act === "abort")).toBe(true)

      // amend-proposed: edit the contract out of band, then /goal amend
      const edited = BUDGET_GOAL.replace("turns: 2", "turns: 5")
      await Bun.write(`${host.project}/.opencode/goals/onabudget/goal.yaml`, edited)
      await host.client.session.command({ sessionID, name: "goal", text: "amend" } as any)
      const amend = await until(() => decisions.find((d) => d.kind === "amend-proposed"), 10000)
      expect(amend.choices.some((c: any) => c.act === "amend" && c.arg === "confirm")).toBe(true)

      // supersede-ack: point a superseder at the live predecessor's real lock, then start it
      const lock = (await run(host, "onabudget")).lock as string
      const superseder = `schema: goal/v1
id: superseder
title: Supersedes the live goal
supersedes: onabudget@${lock.slice(0, 12)}
intent:
  verbatim: v
outcome: done.txt exists
non_goals: [x]
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
plan:
  - {id: S1, title: Write done.txt, proves: [C1]}
`
      await Bun.write(`${host.project}/.opencode/goals/superseder/goal.yaml`, superseder)
      const other = await newSession(host)
      await host.client.session.command({ sessionID: other, name: "goal", text: "start superseder" } as any)
      const ack = await until(() => decisions.find((d) => d.kind === "supersede-ack"), 10000)
      expect(ack.message).toContain("still budget_limited")
      expect(ack.choices.some((c: any) => c.run.includes("acknowledge-supersede"))).toBe(true)
      expect(ack.choices.some((c: any) => c.act === "abort")).toBe(true)
      off?.()
    } finally {
      await host.stop()
    }
  }, 200000)

  test("blocked emits its decision with the blocker key and needs; a failed owner verify on a stopped goal emits paused-after-verdict", async () => {
    const host = await goalHost(script(blockerWorker(), verifierProven), { ".opencode/goals/blocky/goal.yaml": BLOCK_GOAL })
    try {
      const goalRpc = (host.client as any).rpc(GoalRpc)
      const decisions: any[] = []
      const off = goalRpc.events.on("decision", (event: any) => decisions.push(event.data))
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start blocky" } as any)
      await waitStatus(host, ["blocked", "paused"], 90000, "blocky")
      const blocked = await until(() => decisions.find((d) => d.kind === "blocked"), 10000)
      expect(blocked.message).toContain("missing-credential")
      expect(blocked.message).toContain("DEPLOY_TOKEN")
      expect(blocked.choices.some((c: any) => c.act === "resume")).toBe(true)
      expect(blocked.choices.some((c: any) => c.act === "abort")).toBe(true)

      // paused-after-verdict: the owner verifies the stopped goal; C1's file is absent
      await host.client.session.command({ sessionID, name: "goal", text: "verify" } as any)
      const verdict = await until(() => decisions.find((d) => d.kind === "paused-after-verdict"), 15000)
      expect(verdict.message).toContain("Verification did not pass")
      expect(verdict.choices.some((c: any) => c.act === "resume")).toBe(true)
      expect(verdict.choices.some((c: any) => c.act === "amend")).toBe(true)
      expect((await run(host, "blocky")).status).toBe("paused")
      off?.()
    } finally {
      await host.stop()
    }
  }, 150000)
})
