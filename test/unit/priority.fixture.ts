// Shared fixture: a minimal valid goal/v1 body the priority tests extend.
export const DEMO_GOAL_BASE = (extra: string) => `schema: goal/v1
id: demo
title: Demo goal
${extra}intent:
  verbatim: "v"
outcome: something is true
non_goals: [x]
criteria:
  - id: C1
    statement: it SHALL hold
    check: {kind: file, path: done.txt}
plan:
  - {id: S1, title: Do it, proves: [C1]}
`
