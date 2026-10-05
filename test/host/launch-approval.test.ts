// RED STUB — v0.3.1 S2 (T068): launch-approval robustness.
// Honest red for the C19 command check; implementation replaces this body.
// Live defect 2026-10-05: goal_start refused an owner-approved launch because
// app.ts:579 requires the byte-exact label "Start goal now" (the skill's own
// "(Recommended)" suffix breaks it), launchApprovedAt is in-memory (restarts
// void it), and the refusal cannot say which check failed.
import { test } from "bun:test"

test("launch approval: label variants accepted, approval survives a restart within the TTL, refusal names what was observed", () => {
  throw new Error("red stub — T068 launch-approval host scenario lands in this run (plan S2)")
})
