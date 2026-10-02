import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseContract, parseCount, parseDuration } from "../../src/contract/parse"
import { renderSystemBlock, renderTailNote } from "../../src/contract/render"
import { initialRun } from "../../src/engine/state"

const valid = readFileSync(join(import.meta.dir, "..", "fixtures", "valid.goal.yaml"), "utf8")
const errors = (text: string, slug?: string) => parseContract(text, { slug }).issues.filter((i) => i.level === "error").map((i) => `${i.path}: ${i.message}`)
const warnings = (text: string) => parseContract(text).issues.filter((i) => i.level === "warning").map((i) => `${i.path}: ${i.message}`)
const edit = (from: string | RegExp, to: string) => {
  const out = valid.replace(from, to)
  if (out === valid) throw new Error(`fixture edit did not apply: ${from}`)
  return out
}

describe("goal/v1 contract", () => {
  test("a complete contract parses with no errors and fills defaults", () => {
    const result = parseContract(valid, { slug: "checkout-latency" })
    expect(result.issues.filter((i) => i.level === "error")).toEqual([])
    const c = result.contract!
    expect(c.criteria.map((x) => x.id)).toEqual(["C1", "C2", "C3"])
    expect(c.criteria[2]!.essential).toBe(false)
    expect(c.invariants[0]!.essential).toBe(true)
    expect(c.budget).toEqual({ turns: 40, wallMs: 3 * 3_600_000, tokens: 3_000_000, cost_usd: 15 })
    expect(c.autonomy).toEqual({ questions: "defer", on_user_message: "steer", on_interrupt: "pause" })
    expect(c.verification).toEqual({ mode: "host+verifier", max_rejections: 3 })
    expect(c.assumptions[0]!.status).toBe("assumed")
    expect(result.lock).toHaveLength(64)
  })

  const cases: Array<[string, string, RegExp]> = [
    ["missing non-goals", edit(/non_goals:\n  - Redesigning the cart schema\n/, ""), /non_goals: list at least one non-goal/],
    ["no essential criterion", edit(/criteria:\n  - id: C1\n/, "criteria:\n  - id: C1\n    essential: false\n").replace("  - id: C2\n", "  - id: C2\n    essential: false\n"), /at least one criterion must be essential/],
    ["criterion without a check", edit(`    check: {kind: command, run: "npm run test:checkout", expect: {exit: 0}, timeout: 300, live: true}\n`, ""), /check is required/],
    ["unknown check kind", edit("kind: verifier", "kind: vibes"), /unknown check kind "vibes"/],
    ["bad criterion id", edit("  - id: C2", "  - id: crit-2"), /id must look like C1/],
    ["duplicate id", edit("  - id: C2", "  - id: C1"), /duplicate id C1/],
    ["invariant that is not host-checkable", edit(`run: "npm test"}`, `run: "npm test"}\n  - id: I2\n    statement: Code stays readable\n    check: {kind: verifier, ask: readable?}`), /invariants must be host-checkable/],
    ["plan proves an unknown criterion", edit("proves: [C3]", "proves: [C9]"), /unknown criterion C9/],
    ["plan cycle", edit("{id: S1, title: Profile the slow path}", "{id: S1, title: Profile the slow path, depends_on: [S3]}"), /cycle/],
    ["bad budget", edit("wall: 3h", "wall: soon"), /wall must be a duration/],
    ["wrong schema", edit("schema: goal/v1", "schema: goal/v0"), /schema must be "goal\/v1"/],
    ["missing intent", edit(/intent:\n  verbatim: .*\n/, ""), /intent\.verbatim/],
    ["command without run", edit(`run: "npm test"`, `run: ""`), /command check needs run/],
    ["bad regex", edit(`stdout_regex: "p95=(1|2[0-4])\\\\d\\\\dms"`, `stdout_regex: "p95=("`), /not a valid regular expression/],
  ]
  for (const [name, text, pattern] of cases) {
    test(`rejects: ${name}`, () => {
      const found = errors(text)
      expect(found.some((e) => pattern.test(e))).toBe(true)
      expect(parseContract(text).contract).toBeUndefined()
    })
  }

  test("rejects a slug that does not match the directory", () => {
    expect(errors(valid, "other-slug").join("\n")).toMatch(/must match its directory name/)
  })

  test("rejects invalid YAML", () => {
    expect(errors("schema: goal/v1\ncriteria: [unclosed").join("\n")).toMatch(/not valid YAML/)
  })

  test("warns on vague adjectives without a number and on activity outcomes", () => {
    const text = edit("outcome: Checkout API p95 is below 250ms on the documented slow path", "outcome: Keep improving checkout so it is fast and robust")
    const found = warnings(text).join("\n")
    expect(found).toMatch(/reads as an activity/)
    expect(found).toMatch(/fast, robust/)
    expect(parseContract(text).contract).toBeDefined()
  })

  test("durations and counts", () => {
    expect(parseDuration("90m")).toBe(5_400_000)
    expect(parseDuration("1h30m")).toBe(5_400_000)
    expect(parseDuration(45)).toBe(2_700_000)
    expect(parseDuration("soon")).toBeUndefined()
    expect(parseCount("3M")).toBe(3_000_000)
    expect(parseCount("400k")).toBe(400_000)
    expect(parseCount("1.5m")).toBe(1_500_000)
    expect(parseCount("lots")).toBeUndefined()
  })

  test("the system block is byte-stable and carries no run state", () => {
    const { contract, lock } = parseContract(valid)
    const a = renderSystemBlock(contract!, lock)
    const b = renderSystemBlock(contract!, lock)
    expect(a).toBe(b)
    expect(a).toContain('<goal_contract id="checkout-latency"')
    expect(a).toContain("C1: WHEN npm run test:checkout runs")
    expect(a).toContain("Protected paths")
    expect(a).not.toMatch(/turn \d|budget:/i)
  })

  test("the tail note carries the board, plan and verdict", () => {
    const { contract, lock } = parseContract(valid)
    const state = initialRun(contract!, { sessionID: "ses_x", runId: "r1", lock, now: 0 })
    state.turn = 3
    state.criteria.C1 = { status: "pass", by: "host", rejections: 0 }
    state.verdict = { at: 1, turn: 3, passed: false, lines: ["C2 FAILED [host] p95 312ms"] }
    const note = renderTailNote(state, contract!, "verdict", 60_000)
    expect(note).toContain("✓ C1 (host)")
    expect(note).toContain("S1 active")
    expect(note).toContain("HOST VERDICT (turn 3)")
    expect(note).toContain("turns 3/40")
  })
})
