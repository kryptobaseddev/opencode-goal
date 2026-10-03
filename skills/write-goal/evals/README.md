# Trigger evals — route notes (T015)

`trigger_queries.json` feeds `trigger_behavior_eval.py` (skill-evaluator), which runs a
real agent per query and checks whether it invokes this skill.

**Command-routed phrasings are excluded from description measurement.** In OpenCode,
`/goal new <words>` is a registered plugin command that attaches this skill explicitly —
description-based triggering plays no part. The 2026-10-03 run
(`trigger-eval-2026-10-03.json`, 15/16) scored that phrasing as a miss; it is a fixture
artifact, not a description defect. When adding queries:

- **Prose phrasings** ("turn this into a goal", "run this until it's done", "grill me") —
  measure these; the description must trigger them.
- **Slash phrasings** (`/goal new …`) — do not score them against the description; in
  OpenCode they arrive with the skill already attached.

Skill docs (SKILL.md description) carry the same note so future eval authors see it.
