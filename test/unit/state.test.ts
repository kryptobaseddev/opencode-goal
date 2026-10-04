import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { budgetUse, initialRun, modelCan, ownerCan, setStatus } from "../../src/engine/state"
import { Store } from "../../src/engine/store"

const contract = parseContract(readFileSync(join(import.meta.dir, "..", "fixtures", "valid.goal.yaml"), "utf8")).contract!
const fresh = () => initialRun(contract, { sessionID: "ses_1", runId: "r1", lock: "abc", now: 1000 })

describe("run state permissions", () => {
  test("the worker can act only on a running goal in its session", () => {
    expect(modelCan(undefined, "claim")).toMatch(/no goal/)
    const s = fresh()
    expect(modelCan(s, "claim")).toBeUndefined()
    setStatus(s, "paused", "owner")
    expect(modelCan(s, "progress")).toMatch(/owner must resume/)
    setStatus(s, "complete")
    expect(modelCan(s, "claim")).toMatch(/complete/)
  })

  test("while verifying, the worker may only record progress", () => {
    const s = fresh()
    setStatus(s, "verifying")
    expect(modelCan(s, "progress")).toBeUndefined()
    expect(modelCan(s, "claim")).toMatch(/verifying/)
  })

  test("only stopped goals resume; terminal goals cannot be aborted again", () => {
    const s = fresh()
    expect(ownerCan(s, "resume")).toMatch(/only a stopped goal/)
    setStatus(s, "blocked", "x")
    expect(ownerCan(s, "resume")).toBeUndefined()
    setStatus(s, "aborted")
    expect(ownerCan(s, "abort")).toMatch(/already aborted/)
  })

  test("the active clock runs only while running, waiting or verifying", () => {
    const s = fresh()
    setStatus(s, "paused", "x", 61_000)
    expect(s.activeMs).toBe(60_000)
    setStatus(s, "running", undefined, 120_000)
    setStatus(s, "complete", undefined, 180_000)
    expect(s.activeMs).toBe(120_000)
    expect(s.activeSince).toBeNull()
  })

  test("budget use reports the tightest limit", () => {
    const s = fresh()
    s.turn = 20
    s.usage.tokens = 2_700_000
    const use = budgetUse(s, contract, 1000)
    expect(use.ratio).toBeCloseTo(0.9)
    expect(use.parts.map((p) => p.name)).toEqual(["turns", "wall", "tokens", "cost"])
  })
})

describe("store", () => {
  test("run.json writes atomically and the ledger appends", () => {
    const root = mkdtempSync(join(tmpdir(), "ocgoal-store-"))
    const store = new Store(root)
    const s = fresh()
    store.writeRun(s)
    expect(store.readRun("checkout-latency")?.runId).toBe("r1")
    store.ledger("checkout-latency", { type: "start" })
    store.ledger("checkout-latency", { type: "turn", turn: 1 })
    expect(store.readLedger("checkout-latency").map((e) => e.type)).toEqual(["start", "turn"])
  })
})

// T051 — owner approval is final
describe("owner-approved criteria survive re-verification (T051)", () => {
  test("a verifier-kind criterion passed by the owner is skipped by the verifier and recorded as final", async () => {
    const { verifyClaim } = await import("../../src/verify/pipeline")
    const base = `schema: goal/v1
id: t051
title: probe
intent:
  verbatim: v
outcome: o
non_goals: [x]
criteria:
  - id: C1
    statement: judged by the verifier
    check: {kind: verifier, ask: "is it so?"}
  - id: C2
    statement: command passes
    check: {kind: command, run: "exit 0"}
`
    const parsed = parseContract(base, { slug: "t051" })
    if (!parsed.contract) throw new Error("fixture invalid: " + JSON.stringify(parsed.issues))
    const st = initialRun(parsed.contract, { sessionID: "ses_x", runId: "r1", lock: "l", now: 0 })
    st.criteria.C1 = { status: "pass", by: "human", rejections: 0 }
    const calls: string[] = []
    const outcome = await verifyClaim(parsed.contract, st, {
      root: process.cwd(),
      contractText: base,
      verifier: async (input) => {
        calls.push(...input.criteria.map((c) => c.id))
        return { verdicts: [], by: "verifier", error: "verifier did not call goal_verdict" }
      },
    })
    expect(calls).not.toContain("C1") // the verifier never sees the owner-approved criterion
    const c1 = outcome.results.find((r) => r.id === "C1")!
    expect(c1).toMatchObject({ pass: true, by: "human" })
    expect(c1.detail).toContain("final")
  })
})
