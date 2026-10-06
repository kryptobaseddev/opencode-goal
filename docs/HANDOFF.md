# Handoff — opencode-goal

Written 2026-10-02, refreshed through **2026-10-06 (v0.3.2 complete)** across six dogfood runs.
Read this first, then `AGENTS.md`, then [design.md](design.md). Observed OpenCode behaviour:
[spikes.md](spikes.md) (trust it over any doc).

## 1. Where things stand

| | |
|---|---|
| Repo | https://github.com/kryptobaseddev/opencode-goal (public, MIT) |
| Released | **v0.3.2** (tag MOVED once after the owner's first sign-off round failed — see dogfood-5 §7b; git-install proven against both states; installed by the owner, who approved C4 through the native ask-tool form at the reinstall gate) |
| Run `ship-v032-trust-the-card` | **COMPLETE — 16/16 criteria proven** (host + verifier + the owner's C4 sign-off). Not yet archived. Findings: [dogfood-5.md](dogfood-5.md). |
| Tests | 165 pass / 0 fail / 1 skip at the release line; the last flakes were contention-borne and are grace-waited or deterministic by construction (decision-ledger, command-ack form leg) |
| CLEO | T024 (v0.3 epic) done; **T069–T075 all complete with verified gates** — the v0.3.2 board is closed |
| Docs | design · dogfood-1..5 · spikes (S25 keymap modes, S26 pty input starvation, S27 composer-completions, **S28 plugin leader binds impossible**) · HANDOFF |

## 2. What v0.3.2 shipped (trust the card)

- **T072** the card converges to disk truth: the terminal write persists BEFORE the
  reporting layer (a summary failure used to strand a zombie "running" that the next reload
  turned into the lived paused/20-of-22 card), and `recover()` mirrors terminal goals so a
  post-reload snapshot reads the disk truth.
- **T073** readability: the compact card keeps its 12-line cap with a `↳ F9 → <tab>`
  expand affordance; truncated rows carry tab click-through; the panel wraps every row.
- **T074** the panel was UNREACHABLE — spike **S28**: plugin keymap binds cannot join the
  leader chord on 2.0.22 (leader+g never dispatched; that is why the owner had never seen
  the panel). **F9 is the shipped default**; the owner's first sign-off failed with three
  named defects (text wall, tab not cycling with composer focus, nothing selectable) — all
  fixed: panel focus-on-open, always-interactive Decisions tab (decision rows + quick acts
  in one Select), bracketed tabs + section rules. The pty gate is now **11 assertions**.
- **T075** decisions also ask through the native in-composer form (engine → question-tool
  prompt → form; reply dispatches the same act; `decision.resolved` suppresses the other
  surface). Proven live: the owner's own C4 sign-off arrived through it.
- **T069/T070/T071** deferred `/goal` commands acknowledge instantly and run at turn end
  (approve/reject/pause/abort stay immediate); "Decompose with CLEO" is a real act;
  terminal surfaces state the loop stopped and where follow-ups live.

## 3. Next session

1. `cleo briefing`; `cleo session start --scope epic:T002 --name "v0.3.3"`.
2. The v0.3.3 direction: the goal manager board (T077–T079, filed in CLEO). Backlog
   beyond: relay mode, goal queues, home-screen board, Claude Code / Codex adapters,
   headless runner, npm publishing.
3. Housekeeping: `/goal archive ship-v032-trust-the-card` whenever ready (history intact).
4. **S28 re-check on every OpenCode upgrade**: when plugin keymap binds can join the
   leader table, restore the `leader+g` default and the affordance copy (centralized in
   `src/tui/dashboard.ts` + `format.ts`; the gate drives the bind in one place).

## 4. Lessons from the v0.3.2 run (all in dogfood-5)

- Evidence runs and heavy test runs do not mix: the CLEO `tool:test` batch failed
  deterministically while the suite/pty gate ran concurrently (the machine's one
  timing-sensitive test dies under double load), and the same overlap poisoned two host
  verification runs. No background work while a claim is pending.
- The verifier child lottery is real: C13 was judged `proven` on disk while later rounds
  timed out with ZERO messages (the T044 zai hang) — read the transcripts under
  `evidence/<run>/` before re-rolling a claim; the answer may already be there.
- The pty gate needs quiet-key discipline (S26): every keystroke waits for stream
  quiescence, dialogs are answered (ESC does not dismiss `dialog.select`), and the panel
  renders beside the sidebar (don't toggle the sidebar to see it — that replaces the pane).
- A failed owner sign-off is the gate working: name the defects, fix within the existing
  IA, move the single tag, re-prove, re-ask. The tag move is recorded transparently in
  CHANGELOG + dogfood-5 §8.

## 5. Releasing (unchanged)

Bump `package.json` + `CHANGELOG.md` → commit `type(T###)` → `git tag -a vX.Y.Z` →
`git push origin main --follow-tags` → git-install test against the tag → owner reinstalls
(`plugin remove` old, `plugin add` new, `reload`) → verify via `opencode plugin list` or
the npm cache (newest epoch wins). The owner's OpenCode runs the **installed tag**, not
this tree.
