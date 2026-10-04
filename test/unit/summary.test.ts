import { describe, expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import type { Contract } from "../../src/contract/types"
import { buildPostGoalSummary, findingsFromLedger, provenanceCaveat, type SummaryInput } from "../../src/summary/build"
import { completionAudit } from "../../src/summary/audit"

// T045 — the post-goal summary builder. The run's own data (contract, run
// state, ledger) becomes a summary with per-criterion outcomes WITH
// provenance — owner-approved and fallback-passed criteria carry explicit
// caveats, never silently equal to host-proven — plus the T046 scope audit
// flags, restated non-goals, mid-run ledger findings and follow-up prompts
// including the CLEO-install suggestion when the project has no .cleo
// workspace.

const yaml = `schema: goal/v1
id: sum
title: Summary probe
intent:
  verbatim: v
outcome: the thing is done
non_goals:
  - Relay mode
  - npm publishing
criteria:
  - id: C1
    statement: the file exists
    check: {kind: file, path: done.txt}
  - id: C2
    statement: the owner signed off
    check: {kind: human, ask: "is it good?"}
  - id: C3
    statement: the verifier judged it
    check: {kind: verifier, ask: "is it so?"}
invariants:
  - id: I1
    statement: the suite keeps passing
    check: {kind: command, run: "exit 0"}
plan:
  - {id: S1, title: Do the work, proves: [C1, C3]}
  - {id: S2, title: A step that proves nothing, proves: []}
`

const contract = (): Contract => {
  const parsed = parseContract(yaml, { slug: "sum" })
  if (!parsed.contract) throw new Error("fixture invalid: " + JSON.stringify(parsed.issues))
  return parsed.contract
}

const state = (status = "complete") => {
  const st = initialRun(contract(), { sessionID: "ses_s", runId: "r1", lock: "l", now: 1000 })
  st.status = status as any
  st.turn = 7
  st.criteria.C1 = { status: "pass", by: "host", at: 1, rejections: 0, detail: "exit 0 in 0.0s" }
  st.criteria.C2 = { status: "pass", by: "human", at: 2, rejections: 0, detail: "approved by the owner" }
  st.criteria.C3 = { status: "pass", by: "verifier-fallback", at: 3, rejections: 0, detail: "parsed fallback verdict" }
  st.criteria.I1 = { status: "pass", by: "host", at: 4, rejections: 0, detail: "exit 0 in 0.0s" }
  return st
}

const ledgerEvents = [
  { type: "start", source: "command" },
  { type: "flag", criterion: "C3", kind: "ambiguous", reason: "the ask overlaps C1", turn: 2 },
  { type: "blocked", blocker: { key: "missing-token", reason: "no credential", count: 1 }, turn: 3 },
  { type: "verifier-empty", round: 1, turn: 4 },
  { type: "verifier-fallback", count: 1, turn: 4 },
  { type: "amended", generation: 2, summary: "C4 wording tightened", turn: 5 },
  { type: "verdict", passed: false, turn: 4 },
]

describe("provenance caveats", () => {
  test("owner-approved and fallback-passed carry caveats; host and verifier do not", () => {
    expect(provenanceCaveat("human")).toContain("approved by the owner")
    expect(provenanceCaveat("verifier-fallback")).toContain("prose fallback")
    expect(provenanceCaveat("host")).toBeUndefined()
    expect(provenanceCaveat("verifier")).toBeUndefined()
    expect(provenanceCaveat(undefined)).toBeUndefined()
  })
})

describe("mid-run findings from the ledger", () => {
  test("flags, blockers, empty verifier rounds, fallback parses and amendments surface; noise does not", () => {
    const findings = findingsFromLedger(ledgerEvents)
    const kinds = findings.map((f) => f.kind)
    expect(kinds).toEqual(["flag", "blocked", "verifier-empty", "verifier-fallback", "amended"])
    expect(findings[0]!.text).toContain("C3")
    expect(findings[1]!.text).toContain("missing-token")
    expect(findings[2]!.text).toContain("round 1")
    expect(findingsFromLedger([{ type: "start" }, { type: "turn" }, { type: "verdict" }])).toEqual([])
  })
})

describe("buildPostGoalSummary", () => {
  const build = (over: Partial<SummaryInput> = {}) =>
    buildPostGoalSummary({ contract: contract(), state: state(), ledgerEvents, ...over })

  test("per-criterion outcomes carry by: provenance and caveats only where earned", () => {
    const s = build()
    const by = Object.fromEntries(s.criteria.map((c) => [c.id, c]))
    expect(by.C1).toMatchObject({ status: "pass", by: "host" })
    expect(by.C1.caveat).toBeUndefined()
    expect(by.C2).toMatchObject({ status: "pass", by: "human" })
    expect(by.C2.caveat).toContain("approved by the owner")
    expect(by.C3).toMatchObject({ status: "pass", by: "verifier-fallback" })
    expect(by.C3.caveat).toContain("prose fallback")
    expect(s.caveats).toHaveLength(2)
    expect(s.text).toContain("✓ pass C2 [human]")
    expect(s.text).toContain("caveat: approved by the owner")
  })

  test("a failed criterion renders with its first detail line, never a caveat", () => {
    const st = state()
    st.criteria.C3 = { status: "fail", by: "verifier", at: 3, rejections: 2, detail: "quoted text not found in done.txt\nsecond line" }
    const s = buildPostGoalSummary({ contract: contract(), state: st, ledgerEvents })
    expect(s.text).toContain("✗ fail C3 [verifier]")
    expect(s.text).toContain("quoted text not found in done.txt")
    expect(s.criteria.find((c) => c.id === "C3")!.caveat).toBeUndefined()
  })

  test("the scope audit lands as its own flagged section (T046 hook)", () => {
    const s = build({ scopeAudit: completionAudit(contract(), state()) })
    const step = s.scopeAudit.find((f) => f.kind === "step" && f.id === "S2")
    expect(step).toBeDefined()
    expect(step!.why).toContain("discussed but unproven")
    expect(s.text).toContain("Scope audit — discussed but unproven (flagged, not blocking)")
    expect(s.text).toContain("A step that proves nothing")
    // and the follow-ups point at the leftovers
    expect(s.followUps.join("\n")).toContain("follow-up goal")
  })

  test("non-goals are restated verbatim", () => {
    const s = build()
    expect(s.nonGoals).toEqual(["Relay mode", "npm publishing"])
    expect(s.text).toContain("## Non-goals (deliberately not done)")
    expect(s.text).toContain("- Relay mode")
  })

  test("follow-ups include the CLEO-install suggestion exactly when .cleo is absent", () => {
    const without = build()
    expect(without.followUps.join("\n")).toContain("no .cleo workspace")
    expect(without.followUps.join("\n")).toContain("installing it")
    const withCleo = build({ cleo: { source: "config" } })
    expect(withCleo.followUps.join("\n")).not.toContain("no .cleo workspace")
    expect(withCleo.followUps.join("\n")).toContain("already linked")
  })

  test("follow-ups match the terminal status", () => {
    const review = buildPostGoalSummary({ contract: contract(), state: state("needs_review"), ledgerEvents })
    expect(review.followUps.join("\n")).toContain("/goal approve")
    const limited = buildPostGoalSummary({ contract: contract(), state: state("budget_limited"), ledgerEvents })
    expect(limited.followUps.join("\n")).toContain("budget")
    const complete = build()
    expect(complete.followUps.join("\n")).toContain("/goal new")
  })

  test("the headline counts provenance caveats on completion", () => {
    const s = build()
    expect(s.headline).toContain("4/4 criteria proven")
    expect(s.headline).toContain("2 with provenance caveats")
    expect(s.text).toContain("# Post-goal summary — Summary probe")
    expect(s.text).toContain("Outcome (as contracted): the thing is done")
    expect(s.findings.map((f) => f.kind)).toContain("flag")
  })
})
