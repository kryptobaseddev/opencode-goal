import { describe, expect, test } from "bun:test"
import { until } from "./harness"
import { goalHost, newSession, run, script, waitStatus } from "./goal.helpers"
import { GoalRpc } from "../../src/rpc"

// T075 — native ask-tool decisions. Owner directive: every engine decision
// point ALSO asks through OpenCode's native in-composer ask tool with the
// act-able choices as options. The only form-creation surface a server
// plugin has on 2.0.22 is the model's question tool, so the engine
// dispatches a decision prompt and the session's model asks the owner; a
// form reply dispatches the SAME rpc act the TUI dialog carries, and
// answering either surface suppresses the other. Proven end-to-end here:
//   1. needs_review ALSO creates a native form with the act-able options;
//   2. answering the form dispatches the same act (approve → verify →
//      complete) and emits decision.resolved via "form";
//   3. the complete decision ALSO creates a form (re-asked after the busy
//      turn ends — decisions never lose their form);
//   4. duplicate suppression: answering via the dialog act first makes the
//      stale form's late reply a no-op (no double act).

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

/** The decision forms, exactly as the engine's prompt tells the model to ask
 *  them (labels mirror the decision choices; the ask tool requires a
 *  description per option). */
const DECISION_OPTIONS: Record<string, Array<{ value: string; label: string; description: string }>> = {
  needs_review: [
    { value: "Approve C4 (triggers verify)", label: "Approve C4 (triggers verify)", description: "your approval is final and never re-checked" },
    { value: "Reject with a reason", label: "Reject with a reason", description: "mark the criterion failed and say why" },
    { value: "Show status", label: "Show status", description: "guidance — see the full board" },
  ],
  complete: [
    { value: "Start the next goal", label: "Start the next goal", description: "open the write-goal interview" },
    { value: "Archive goal", label: "Archive goal", description: "demote to goals-archive/ (history intact)" },
    { value: "Install CLEO for tracking", label: "Install CLEO for tracking", description: "guidance — no .cleo workspace yet" },
  ],
}

const askedKinds = new Set<string>()
const worker = () => (req: any, turn: { trigger: string; results: number; all: string }) => {
  // T075: the engine's decision prompt → ask the owner with the question
  // tool (the native in-composer form). The NEWEST decision prompt wins
  // (earlier ones stay in the transcript), once per kind — a blocking
  // question waits for the owner's reply.
  const kinds = [...turn.all.matchAll(/goal-decision \(kind=([a-z_-]+),/g)].map((m) => m[1]!)
  const decision = kinds.at(-1)
  if (decision && !askedKinds.has(decision)) {
    askedKinds.add(decision)
    const options = DECISION_OPTIONS[decision] ?? []
    return { toolCalls: [{ name: "question", args: { questions: [{ question: `Goal decision (${decision}) — what next?`, header: "Goal", options }] } }] }
  }
  if (turn.trigger.includes("goal started") || turn.trigger.includes("goal turn") || turn.trigger.includes("host verdict")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok - asktool\n" } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence: { C1: "wrote done.txt", C4: "the owner should sign off" } } }] }
  }
  return { text: "Nothing else to do." }
}

const proven = () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "ok", evidence: [{ path: "done.txt", quote: "status: ok" }] }] } }] })

describe("native ask-tool decisions (T075)", () => {
  test("a decision end-to-end through the form: created with act-able options, reply dispatches the same act, both surfaces suppress", async () => {
    const host = await goalHost(script(worker(), proven), {
      ".opencode/goals/review/goal.yaml": REVIEW_GOAL,
    })
    try {
      const sessionID = await newSession(host)
      const goalRpc = (host.client as any).rpc(GoalRpc)
      const resolved: any[] = []
      goalRpc.events.on("decision.resolved", (event: any) => resolved.push(event.data))
      const formsOf = async (marker: string) => {
        const listed = (await (host.client.session.form as any).list({ sessionID })) as Array<{ id: string; fields: Array<{ options?: Array<{ label: string }> }> }>
        return listed.find((f) => f.fields?.[0]?.options?.some((o) => o.label.includes(marker)))
      }

      // ── 1. needs_review ALSO asks through a native form ──
      await host.client.session.command({ sessionID, name: "goal", text: "start review" } as any)
      await waitStatus(host, ["needs_review"], 90000, "review")
      const reviewForm = await until(async () => await formsOf("Approve C4"), 30000, 300)
      expect(reviewForm).toBeDefined()
      const labels = reviewForm.fields[0]!.options!.map((o) => o.label)
      expect(labels).toContain("Approve C4 (triggers verify)")
      expect(labels).toContain("Reject with a reason")

      // ── 2. answering the form dispatches the SAME act the dialog carries ──
      await (host.client.session.form as any).reply({ sessionID, formID: reviewForm.id, answer: { q0: "Approve C4 (triggers verify)" } })
      // (needs_review is the PRE-reply status; wait for complete itself)
      const done = await waitStatus(host, ["complete"], 120000, "review")
      expect(done.status).toBe("complete")
      expect(done.criteria.C4).toMatchObject({ status: "pass", by: "human" })
      const viaForm = await until(async () => resolved.find((r) => r.via === "form" && r.kind === "needs_review"), 15000)
      expect(viaForm).toBeDefined()

      // ── 3. the complete decision ALSO asks through a form (re-asked after
      //      the busy turn ends) ──
      const completeForm = await until(async () => await formsOf("Archive goal"), 60000, 400)
      expect(completeForm).toBeDefined()
      expect(completeForm.fields[0]!.options!.map((o) => o.label)).toContain("Start the next goal")

      // ── 4. duplicate suppression: answer via the DIALOG act first — the
      //      stale form's late reply must be a no-op ──
      const archived = await goalRpc.act({ sessionID, action: "archive" })
      expect(archived.ok).toBe(true)
      const viaDialog = await until(async () => resolved.find((r) => r.via === "dialog" && r.kind === "complete"), 15000)
      expect(viaDialog).toBeDefined()
      // the stale form still exists in the composer; replying to it late
      // finds no pending decision and double-fires nothing (the archive
      // ledger stays at exactly one entry, and no second decision resolution)
      await (host.client.session.form as any).reply({ sessionID, formID: completeForm.id, answer: { q0: "Archive goal" } })
      await Bun.sleep(1500)
      const archiveLedger = (await host.readProject(".opencode/goals-archive/review/ledger.jsonl")).trim().split("\n").map((l) => JSON.parse(l))
      expect(archiveLedger.filter((e) => e.type === "archived")).toHaveLength(1)
      expect(archiveLedger.filter((e) => e.type === "decision-form-answered" && e.kind === "complete")).toHaveLength(0)
      expect(resolved.filter((r) => r.kind === "complete").length).toBe(1)
    } finally {
      await host.stop()
    }
  }, 240000)
})
