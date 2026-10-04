// T044 (plan S1) — RED STUB, replaced by the real scenario when the fix lands.
// Real scenario: the fixture provider returns an EMPTY first response; the
// verifier child must still yield a verdict or a recorded, parseable fallback
// (retried / ledgered) — never a silent empty exchange like turn 4 of run
// 10388d06d001.
import { test, expect } from "bun:test"

test("RED STUB (S1/T044): an empty child exchange is handled, not silent", () => {
  expect(true).toBe(false)
})
