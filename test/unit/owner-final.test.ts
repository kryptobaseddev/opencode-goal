import { describe, expect, test } from "bun:test"
import { parseContract, lockOf } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import type { Contract } from "../../src/contract/types"
import { verifyClaim } from "../../src/verify/pipeline"

// T057 — owner-final beats host re-checks too. Live case (2026-10-04):
// /goal approve C15 (host-kind contains check) set pass by:human, then
// /goal verify re-ran the host check whose needle had gone stale on a patch
// release and FAILED it — the approval was stomped by a HOST result. The
// T051 fix only filtered the verifier list. Here: criteria passed by:human
// are skipped by host re-verification as well, the check never executes,
// the result is recorded as approved-by-owner (final), and no stale check
// can flip the outcome.

const contractText = (mode = "host"): string => `schema: goal/v1
id: t057
title: probe
intent:
  verbatim: v
outcome: o
non_goals: [x]
verification:
  mode: ${mode}
criteria:
  - id: C1
    statement: the version file carries the current version
    check: {kind: command, run: "grep -q 'version: 0.2.0' version.txt"}
  - id: C2
    statement: the marker line exists
    check: {kind: contains, path: version.txt, text: "version: 0.2.0"}
  - id: C3
    statement: a plain command passes
    check: {kind: command, run: "exit 0"}
`

const parsedContract = (mode = "host"): Contract => {
  const parsed = parseContract(contractText(mode), { slug: "t057" })
  if (!parsed.contract) throw new Error("fixture invalid: " + JSON.stringify(parsed.issues))
  return parsed.contract
}

/** A run state whose lock matches the contract text (integrity-clean). */
const cleanState = (contract: Contract, mode = "host") =>
  initialRun(contract, { sessionID: "ses_x", runId: "r1", lock: lockOf(contractText(mode)), now: 0 })

/** A shell spy that records every host command and emulates the stale-needle
 *  world: the version grep fails, plain `exit 0` passes. If an
 *  owner-approved criterion's check runs at all, the test catches it. */
const spyShell = (ran: string[]) => async (command: string) => {
  ran.push(command)
  const ok = command.trim() === "exit 0"
  return { exit: ok ? 0 : 1, stdout: "", stderr: ok ? "" : "stale needle", ms: 1 }
}

describe("owner-final beats host re-checks (T057)", () => {
  test("a HOST-kind criterion passed by:human is skipped by host re-verification and recorded as final", async () => {
    const contract = parsedContract()
    const st = cleanState(contract)
    // the owner approved C1 and C2; the on-disk needle is now stale (0.2.2 shipped)
    st.criteria.C1 = { status: "pass", by: "human", rejections: 0 }
    st.criteria.C2 = { status: "pass", by: "human", rejections: 0 }
    const ran: string[] = []
    const outcome = await verifyClaim(contract, st, {
      root: process.cwd(),
      contractText: contractText(),
      shell: spyShell(ran) as any,
    })

    // neither approved check executed: C1's command never ran (the spy saw only C3)…
    expect(ran).toEqual(["exit 0"])
    // …and both carry exactly one final owner entry, never a host result
    for (const id of ["C1", "C2"]) {
      const rows = outcome.results.filter((r) => r.id === id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ pass: true, by: "human" })
      expect(rows[0]!.detail).toContain("approved by the owner (final)")
    }
    // C3 (not approved) did run and passed via the shell — the spy was reached
    expect(outcome.results.find((r) => r.id === "C3")).toMatchObject({ pass: true, by: "host" })
    // no verdict line ever flags an owner-approved criterion
    const joined = outcome.lines.join("\n")
    expect(joined).not.toContain("C1 FAILED")
    expect(joined).not.toContain("C2 FAILED")
    expect(joined).not.toContain("C3 FAILED")
  })

  test("owner-approved HOST criteria carry the whole outcome: passed=true despite stale checks", async () => {
    const contract = parsedContract()
    const st = cleanState(contract)
    for (const id of ["C1", "C2", "C3"]) st.criteria[id as "C1"] = { status: "pass", by: "human", rejections: 0 }
    const outcome = await verifyClaim(contract, st, {
      root: process.cwd(),
      contractText: contractText(),
      shell: spyShell([]) as any,
    })
    expect(outcome.passed).toBe(true)
    expect(outcome.integrity).toHaveLength(0)
    expect(outcome.results.every((r) => r.by === "human" && r.pass)).toBe(true)
    expect(outcome.lines[0]).toContain("All required criteria passed")
  })

  test("strict mode: an owner-approved HOST criterion is re-checked by neither host nor verifier, exactly one result", async () => {
    const contract = parsedContract("strict")
    const st = cleanState(contract, "strict")
    st.criteria.C1 = { status: "pass", by: "human", rejections: 0 }
    const ran: string[] = []
    const verifierCriteria: string[] = []
    const outcome = await verifyClaim(contract, st, {
      root: process.cwd(),
      contractText: contractText("strict"),
      shell: spyShell(ran) as any,
      verifier: async (input) => {
        verifierCriteria.push(...input.criteria.map((c) => c.id))
        return { verdicts: [], by: "verifier", error: "no verdict" }
      },
    })
    // C1 never reached the verifier child and never ran a host command…
    expect(verifierCriteria).not.toContain("C1")
    expect(outcome.results.filter((r) => r.id === "C1")).toHaveLength(1)
    expect(outcome.results.find((r) => r.id === "C1")).toMatchObject({ pass: true, by: "human" })
    // …while C3 (not approved, host-passed under the spy) did reach the strict verifier
    expect(verifierCriteria).toContain("C3")
  })

  test("host-kind criteria NOT approved by the owner still run their checks (no over-skipping)", async () => {
    const contract = parsedContract()
    const st = cleanState(contract)
    const ran: string[] = []
    const outcome = await verifyClaim(contract, st, {
      root: process.cwd(),
      contractText: contractText(),
      shell: spyShell(ran) as any,
    })
    // both commands ran via the spy; the contains check ran and failed on the missing file
    expect(ran).toEqual([`grep -q 'version: 0.2.0' version.txt`, "exit 0"])
    expect(outcome.results.find((r) => r.id === "C1")).toMatchObject({ pass: false, by: "host" })
    expect(outcome.results.find((r) => r.id === "C2")).toMatchObject({ pass: false, by: "host" })
    expect(outcome.results.find((r) => r.id === "C3")).toMatchObject({ pass: true, by: "host" })
  })
})
