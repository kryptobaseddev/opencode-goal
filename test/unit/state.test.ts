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
