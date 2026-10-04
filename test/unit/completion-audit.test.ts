import { describe, expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import type { Contract } from "../../src/contract/types"
import { completionAudit, scopeItemMaps, tokens } from "../../src/summary/audit"
import { buildPostGoalSummary } from "../../src/summary/build"

// T046 — the completion scope audit, owner decision 2026-10-04: FLAGGED
// CAVEAT, never a block. Plan steps with proves:[] and no sibling evidence
// of work, and scope.in lines mapping to no criterion outcome, surface in
// the post-goal summary as discussed-but-unproven; the run still completes.

const yaml = (scopeIn: string[] = []): string => `schema: goal/v1
id: audit
title: Audit probe
intent:
  verbatim: v
outcome: the thing is done
scope:
  in:
${scopeIn.map((l) => `    - "${l.replace(/"/g, '\\"')}"`).join("\n")}
  out: []
non_goals: [x]
criteria:
  - id: C1
    statement: done.txt exists and states ok
    check: {kind: contains, path: done.txt, text: "status: ok"}
  - id: C2
    statement: the suite passes
    check: {kind: command, run: "bun test"}
plan:
  - {id: S1, title: Write done.txt, proves: [C1]}
  - {id: S2, title: A step that proves nothing, proves: []}
  - {id: S3, title: Another proves-nothing step, proves: []}
`

const contract = (scopeIn: string[] = []): Contract => {
  const parsed = parseContract(yaml(scopeIn), { slug: "audit" })
  if (!parsed.contract) throw new Error("fixture invalid: " + JSON.stringify(parsed.issues))
  return parsed.contract
}

const state = (steps: Record<string, string> = {}) => {
  const st = initialRun(contract(), { sessionID: "ses_a", runId: "r1", lock: "l", now: 0 })
  st.steps = { ...steps } as any
  st.criteria.C1 = { status: "pass", by: "host", at: 1, rejections: 0, detail: "contains the expected text" }
  st.criteria.C2 = { status: "pass", by: "host", at: 1, rejections: 0, detail: "exit 0" }
  return st
}

describe("scope-item mapping", () => {
  test("tokens are lowercase, ≥4 chars, stopword-stripped, plural/past-normalized", () => {
    expect(tokens("The verifier child models were resolved quickly!")).toEqual(["verifier", "child", "model", "resolv", "quickly"])
  })

  test("a scope line maps via direct mention or ≥2 shared tokens; unrelated lines do not map", () => {
    const c = contract().criteria
    expect(scopeItemMaps("done.txt exists and states ok", c)).toBe(true) // direct mention
    expect(scopeItemMaps("make done.txt carry the status line", c)).toBe(true) // token overlap
    expect(scopeItemMaps("relay mode queues for the home screen", c)).toBe(false)
  })
})

describe("completionAudit", () => {
  test("a proves:[] step with no recorded work is flagged discussed-but-unproven", () => {
    const flags = completionAudit(contract(), state())
    const s2 = flags.find((f) => f.kind === "step" && f.id === "S2")
    expect(s2).toMatchObject({ title: "A step that proves nothing" })
    expect(s2!.why).toContain("proves no criterion")
    expect(s2!.why).toContain("discussed but unproven")
    // both untouched steps flag
    expect(flags.filter((f) => f.kind === "step").map((f) => f.id).sort()).toEqual(["S2", "S3"])
  })

  test("sibling evidence of work (done or active) unflags a proves:[] step", () => {
    const flags = completionAudit(contract(), state({ S2: "done", S3: "active" }))
    expect(flags.filter((f) => f.kind === "step")).toEqual([])
  })

  test("steps that prove criteria are never flagged, whatever their outcome", () => {
    const st = state({ S1: "pending" }) // S1 proves C1 but was never marked done
    const flags = completionAudit(contract(), st)
    expect(flags.find((f) => f.id === "S1")).toBeUndefined()
    const failing = state()
    failing.criteria.C1 = { status: "fail", by: "host", at: 1, rejections: 1, detail: "not found" }
    expect(completionAudit(contract(), failing).find((f) => f.id === "S1")).toBeUndefined()
  })

  test("scope.in items mapping to no criterion are flagged; mapped ones are not", () => {
    const c = contract(["done.txt exists and states ok", "relay mode queues for the home screen"])
    const flags = completionAudit(c, state())
    const scope = flags.filter((f) => f.kind === "scope")
    expect(scope).toHaveLength(1)
    expect(scope[0]).toMatchObject({ id: "relay mode queues for the home screen" })
    expect(scope[0]!.why).toContain("no criterion statement or check maps to it")
  })

  test("the audit never blocks completion: it only feeds the summary's caveat section", () => {
    const c = contract(["relay mode queues for the home screen"])
    const st = state()
    st.status = "complete" as any
    const summary = buildPostGoalSummary({ contract: c, state: st, scopeAudit: completionAudit(c, st) })
    // the run completed with every criterion proven; the flags ride along as caveats
    expect(summary.status).toBe("complete")
    expect(summary.headline).toContain("2/2 criteria proven")
    expect(summary.scopeAudit.map((f) => f.id)).toContain("relay mode queues for the home screen")
    expect(summary.scopeAudit.map((f) => f.id)).toContain("S2")
    expect(summary.text).toContain("flagged, not blocking")
    expect(summary.followUps.join("\n")).toContain("follow-up goal")
  })
})
