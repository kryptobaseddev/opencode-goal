import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { M, MESSAGE_BUILDERS, renderMessage, type Choice, type EngineMessage } from "../../src/server/messages"

// T054 — actionable message content. Owner directive: every toast, banner
// and dialog carries the CAUSE plus CONCRETE CHOICES. This suite pins that
// no engine notice is actionless: every registered builder yields a cause
// and at least one runnable choice, and app.ts renders no raw notice
// strings (everything goes through the builders).

const samples: Record<string, () => EngineMessage> = {
  goalStarted: () => M.goalStarted("Ship the widget"),
  cleanStarted: () => M.cleanStarted("ses_123", "ship-v031"),
  startPicker: () => M.startPicker([{ slug: "demo", title: "Demo", valid: true }]),
  startPickerEmpty: () => M.startPickerEmpty(2),
  goalSummary: () => M.goalSummary("goal complete — 5/5 criteria proven", 2, "complete"),
  amended: () => M.amended(2, "C15 needle 0.2.0 → 0.2.2"),
  pausedAdmissionError: () => M.pausedAdmissionError("socket closed"),
  awaitingAnswer: () => M.awaitingAnswer("which provider?"),
  pausedUserMessage: () => M.pausedUserMessage(),
  budgetStopped: () => M.budgetStopped("Ship the widget"),
  blocked: () => M.blocked("missing-stripe-key", "no credential", "a Stripe API key"),
  pausedInterrupted: () => M.pausedInterrupted("interrupted: dismissed question"),
  pausedStalled: () => M.pausedStalled("stalled: no change for 3 turns"),
  verifying: () => M.verifying(),
  complete: () => M.complete("Ship the widget", 0),
  needsSignOff: () => M.needsSignOff(["C4", "C7"]),
  needsReview: () => M.needsReview("C15 rejected 3 times"),
  claimRejected: () => M.claimRejected("C15 FAILED [host] output lacks \"0.3.0\""),
  attached: () => M.attached("Ship the widget", "paused"),
  archived: () => M.archived("Ship the widget", "ship-the-widget"),
  goalWait: () => M.goalWait(120, "build running"),
  commandDeferred: () => M.commandDeferred("resume", "turn"),
  amendProposed: () => M.amendProposed("outcome: unchanged · criteria changed [C15]"),
  supersedeAck: () => M.supersedeAck("ship-v3", "ship-v2", "running"),
  pausedAfterVerdict: () => M.pausedAfterVerdict("C15 FAILED [host] output lacks \"0.3.0\""),
  completeDecision: () => M.completeDecision("Ship the widget", false, 2),
}

/** A choice is concrete when it names a command, a worker tool, or an
 *  imperative phrase — never a bare noun or empty hint. */
const concrete = (c: Choice) =>
  c.run.startsWith("/goal") || c.run.startsWith("goal_") || /^(reply|keep|edit|read|answer|watch|open|install|decompose|start|create|cleo)\b/i.test(c.run)

describe("no engine notice is actionless (T054)", () => {
  test("the registry covers every builder in M", () => {
    expect(new Set(MESSAGE_BUILDERS)).toEqual(new Set(Object.keys(samples)))
  })

  test("every message carries a cause and ≥1 concrete choice", () => {
    for (const [name, build] of Object.entries(samples)) {
      const m = build()
      expect(m.text.length, `${name} has a cause`).toBeGreaterThan(10)
      expect(m.choices.length, `${name} has choices`).toBeGreaterThanOrEqual(1)
      for (const c of m.choices) {
        expect(c.label.length, `${name} choice label`).toBeGreaterThan(2)
        expect(concrete(c), `${name} choice "${c.run}" is concrete`).toBe(true)
      }
      expect(["info", "success", "warning", "error"], `${name} level`).toContain(m.level)
    }
  })

  test("rendering keeps the choices visible in plain text (a toast stays actionable)", () => {
    const m = M.needsSignOff(["C4"])
    const rendered = renderMessage(m)
    expect(rendered).toContain("sign-off")
    for (const c of m.choices) expect(rendered).toContain(c.run)
    expect(rendered).toContain(" — ")
  })

  test("the message ids name their decision points", () => {
    for (const id of ["goal.complete", "goal.needs-review.signoff", "goal.blocked", "goal.budget.stopped"]) {
      const name = Object.entries(samples).find(([, build]) => build().id === id)
      expect(name, id).toBeDefined()
    }
  })
})

describe("app.ts renders no raw engine notices (drift guard)", () => {
  const source = readFileSync(join(import.meta.dir, "..", "..", "src", "server", "app.ts"), "utf8")

  test("every this.notice( outside the say helper is gone — engine notices go through noticeM", () => {
    const hits = [...source.matchAll(/this\.notice\(/g)]
    expect(hits.length).toBe(1) // the say() helper itself; say echoes already carry choice tails
    const sayRegion = source.slice(source.indexOf("const say ="))
    expect(sayRegion.includes("this.notice(sessionID, message, level)")).toBe(true)
  })

  test("the engine wires a healthy number of builder notices", () => {
    expect((source.match(/this\.noticeM\(/g) ?? []).length).toBeGreaterThanOrEqual(12)
  })

  test("every M.<builder> referenced in app.ts exists in the registry", () => {
    const used = new Set([...source.matchAll(/\bM\.([a-zA-Z]+)/g)].map((m) => m[1]!))
    expect(used.size).toBeGreaterThanOrEqual(12)
    for (const name of used) expect(MESSAGE_BUILDERS, name).toContain(name)
  })
})
