# Recon — ship-v032-trust-the-card

Facts from the v0.3.1 completion (the owner's live reports ARE the recon). 2026-10-06.

## Baseline

- v0.3.1 installed and complete: run `ship-v031-launch-experience` 22/22 (not yet archived —
  terminal, so a new goal can start alongside it). Suite 150/0/1, typecheck green at `fb89afd`.
- The engine emits `updated` on every persist; the TUI refreshes via events + render-time
  `refreshIfStale` + a 4s ticker that SKIPS terminal views (`src/tui/index.tsx:121`).

## The owner's live findings (all reproduced or code-confirmed)

- **Stale card (T072)**: the card showed paused/20-of-22/turn-7/"S11 dogfood-4" after the run
  completed 22/22 on disk — the stream dropped across the reinstall reloads and never
  converged. The ticker skip is terminal-only, so a stale non-terminal snapshot has the ticker
  working against a dead stream; the recovery path lacks a forced re-fetch on reconnect.
- **Truncation (T073)**: card rows cut off unreadable; the 12-line cap has no expand, no
  click-through; no width scaling guarantees.
- **Dashboard unseen (T074)**: the T056 tabs/panel have only snapshot coverage.
- **Dead-end guidance (T070)**: "Decompose with CLEO" has no act — picking it only toasts.
- **Silent completion (T071)**: tracer clears at terminal (by design) with no end-state copy.
- **Silent command queue (T069)**: `/goal start` sat ~9 min behind an active turn, no ack.
- **Ask-tool directive (T075)**: decisions must ask through native OpenCode forms. The engine
  already listens to `form.replied` (launch approvals, T068) and the client exposes
  `session.form.create({sessionID, title, fields})` / `session.form.reply` — proven shapes
  from the launch-approval test. The plugin-side form creation surface needs a spike (ctx
  method vs client passthrough) — first plan step of S4.

## Verbatim-quote discipline (the C18 lesson)

dogfood-5 carries fenced byte-exact ledger anchors FROM THE START (the C13 ask instructs the
verifier to quote them). Three children judged v0.3.1's doc proven; only the third's citation
survived the host quote re-read.

## Needle rehearsals (red at commit)

- package.json 0.3.1 → `startsWith('0.3.2')` false.
- `grep -c "## 0.3.2" CHANGELOG.md` → 0.
- docs/dogfood-5.md absent.
- The 6 new stubs fail; `--assert` goes red via two pending assertions.

## Correlation

| Step | Task(s) |
|---|---|
| S1 convergence | T072 |
| S2 card readability | T073 |
| S3 riders | T071, T070, T069 |
| S4 native forms | T075 |
| S5 gate extension | T072+T074 (pty) |
| S6 release + sign-off | T074 (human) + release |
| S7 dogfood-5 + closes | T069–T075 |
