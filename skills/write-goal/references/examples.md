# Worked examples

Four complete `goal/v1` contracts, one per common class (bugfix, perf, migration,
feature). Copy one into `.opencode/goals/<slug>/goal.yaml`, replace the placeholders
with facts from your recon, and validate (`goal_validate({slug})` or the parser).

Every example here parses with the plugin's own `parseContract` — treat them as
templates that must stay valid, not as prose.

---

## 1 · Bugfix — a timeout that only happens on slow networks

```yaml
schema: goal/v1
id: fix-login-timeout
title: Login no longer times out on 3G
intent:
  verbatim: 'login keeps timing out on slow networks, fix it'
outcome: Login completes on a 3G-throttled connection without a timeout error
non_goals:
  - Redesigning the login page
  - Touching the session refresh flow
criteria:
  - id: C1
    statement: WHEN the login e2e test runs under 3G throttling THE login SHALL succeed
    check:
      kind: command
      run: npm run test:e2e -- login-slow
      expect: { exit: 0 }
      live: true
      timeout: 300
  - id: C2
    statement: 'No hard-coded 5s timeout remains in src/auth'
    check:
      kind: absent
      pattern: 'timeout:\s*5000'
      paths: [src/auth]
invariants:
  - id: I1
    statement: The full unit suite SHALL CONTINUE TO pass
    check:
      kind: command
      run: npm test
      expect: { exit: 0 }
protect: ['test/e2e/**']
plan:
  - id: S1
    title: Reproduce under throttling
    proves: []
  - id: S2
    title: Fix the timeout handling
    proves: [C1, C2]
    depends_on: [S1]
assumptions:
  - id: A1
    text: 3G profile is 400ms RTT / 400kbps
    rationale: Chrome DevTools preset
    reversible: true
stop:
  escalate_when:
    - 'The fix needs a backend API change'
```

---

## 2 · Perf — a render pass that must get measurably faster

```yaml
schema: goal/v1
id: speed-up-render
title: Board render is at least 3x faster on 10k rows
intent:
  verbatim: 'the board takes forever to render with 10k rows, make it at least 3 times faster'
outcome: The render benchmark reports speedup of 3 or more versus the baseline, with no visual regressions
non_goals:
  - Rewriting the board in a different framework
  - Changing the rendered markup or styling
criteria:
  - id: C1
    statement: THE render benchmark SHALL report speedup of 3 or more across 3 runs
    check:
      kind: command
      run: node bench/render.mjs --runs 3
      expect: { stdout_regex: 'speedup=([3-9]|\d{2,})' }
      runs: 3
  - id: C2
    statement: THE board snapshot SHALL be unchanged
    check:
      kind: command
      run: npm test -- board.snapshot
      expect: { exit: 0 }
invariants:
  - id: I1
    statement: The full test suite SHALL CONTINUE TO pass
    check:
      kind: command
      run: npm test
      expect: { exit: 0 }
  - id: I2
    statement: 'The baseline bench result (bench/baseline.json) SHALL NOT change'
    check:
      kind: diff
      paths: [bench/baseline.json]
protect: ['bench/**']
scope:
  in:
    - 'src/board render path only'
  out:
    - 'The data-loading pipeline'
stop:
  escalate_when:
    - 'Speedup 2x is reachable but 3x needs a data-model change'
```

---

## 3 · Migration — retire an old client without behaviour change

```yaml
schema: goal/v1
id: drop-legacy-client
title: Every call site uses the new API client
intent:
  verbatim: 'remove every legacyClient call and move to the new api client, nothing should behave differently'
outcome: 'No legacyClient import or call remains in src/, the suite and typecheck pass, and MIGRATION.md documents the replacement for every removed call'
non_goals:
  - Changing request payloads or endpoints
  - Deleting the legacy client package from package.json
criteria:
  - id: C1
    statement: 'No legacyClient reference remains in src/'
    check:
      kind: absent
      pattern: 'legacyClient\.'
      paths: [src]
  - id: C2
    statement: The typecheck and full suite pass after the migration
    check:
      kind: command
      run: npm run typecheck && npm test
      expect: { exit: 0 }
      timeout: 600
  - id: C3
    statement: MIGRATION.md lists a replacement for every removed call
    check:
      kind: verifier
      ask: >-
        Read MIGRATION.md and git log for this run. For every legacyClient call site
        removed, does MIGRATION.md name the new-api replacement? Quote one line per
        gap you find.
invariants:
  - id: I1
    statement: 'The public API surface (api/public.d.ts) SHALL NOT change'
    check:
      kind: diff
      paths: [api/public.d.ts]
protect: ['api/public.d.ts']
plan:
  - id: S1
    title: Map every legacyClient call site
    proves: []
  - id: S2
    title: Replace call sites in dependency order
    proves: [C1]
  - id: S3
    title: Document replacements in MIGRATION.md
    proves: [C3]
    depends_on: [S2]
```

---

## 4 · Feature — an export button with observable behaviour per scenario

```yaml
schema: goal/v1
id: csv-export
title: Users can export the orders table as CSV
intent:
  verbatim: 'add an export button to the orders table that downloads a csv'
outcome: The orders table has an Export CSV button that downloads the currently filtered rows as valid CSV
non_goals:
  - XLSX or PDF export
  - Server-side async export jobs
criteria:
  - id: C1
    statement: WHEN the user clicks Export CSV with filters applied THE download SHALL contain exactly the filtered rows in display order
    check:
      kind: command
      run: npm run test:e2e -- orders-export
      expect: { exit: 0 }
      live: true
  - id: C2
    statement: THE csv writer SHALL escape quotes, commas and newlines
    check:
      kind: command
      run: npm test -- csvWriter
      expect: { exit: 0 }
  - id: C3
    statement: The export button is approved design-wise by the owner
    check:
      kind: human
      ask: 'Open the orders page and confirm the Export CSV button matches the design mock'
invariants:
  - id: I1
    statement: The full test suite SHALL CONTINUE TO pass
    check:
      kind: command
      run: npm test
      expect: { exit: 0 }
  - id: I2
    statement: No new runtime dependency SHALL be added
    check:
      kind: contains
      path: package.json
      text: '"dependencies": {'
scope:
  in:
    - 'src/orders table, src/lib/csv writer, e2e coverage'
  out:
    - 'Other tables and pages'
stop:
  escalate_when:
    - 'Exports above 50k rows would need a streaming format change'
```

---

## What makes these pass

- Every criterion is **binary and able to fail**: a command that can exit non-zero, a
  pattern that can still be present, a question a verifier can answer "no" to.
- Invariants pin what must not regress; `protect` pins the files the worker may never
  edit (oracles, baselines, public API surfaces).
- Each has at least one **non-goal**, so the loop cannot invent scope when it stalls.
- Budgets are absent on purpose — the goals stop on proof or an honest blocker.
