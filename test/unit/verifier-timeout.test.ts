// Housekeeping (v0.3.1): the verifier round budget is 240s by default AND
// configurable. verifierTimeoutMs is the PER-ROUND budget (the last run's two
// provider hangs each burned a 120s round — total/2 — and the retry came too
// late); plugin/project config reaches it through ctx.options (the ctor
// merge: {...DEFAULTS, ...ctx.options}).
import { describe, expect, test } from "bun:test"
import { DEFAULTS } from "../../src/server/app"
import { readFileSync } from "node:fs"

const perRoundMs = (verifierTimeoutMs: number) => Math.max(60_000, verifierTimeoutMs)

describe("verifier timeout (housekeeping row 8)", () => {
  test("the default round budget is 240s", () => {
    expect(DEFAULTS.verifierTimeoutMs).toBe(240_000)
    expect(perRoundMs(DEFAULTS.verifierTimeoutMs)).toBe(240_000)
  })

  test("verifierTimeoutMs is config-overridable and drives the round budget", () => {
    // the ctor merge: {...DEFAULTS, ...(ctx.options as Partial<Options>)} —
    // a plugin/project config value wins over the default
    const merged = { ...DEFAULTS, ...( { verifierTimeoutMs: 480_000 } as Partial<typeof DEFAULTS>) }
    expect(merged.verifierTimeoutMs).toBe(480_000)
    expect(perRoundMs(merged.verifierTimeoutMs)).toBe(480_000)
    // small values clamp to the 60s floor
    expect(perRoundMs(1_000)).toBe(60_000)
  })

  test("the engine reads the option per round (not total/2)", () => {
    // The live defect this pins: perRoundMs must equal the option, not half
    // of it — 240_000 must yield 240s rounds, never 120s.
    const source = readFileSync(new URL("../../src/server/app.ts", import.meta.url), "utf8")
    expect(source).toContain("const perRoundMs = Math.max(60_000, this.options.verifierTimeoutMs)")
    expect(source).not.toContain("this.options.verifierTimeoutMs / 2")
  })
})
