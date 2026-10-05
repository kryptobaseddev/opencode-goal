# Dogfood 4 — the v0.3.1 launch-experience run

Run `ship-v031-launch-experience` (`10a52d01a001`, lock `19fcd8af`, base `b93cd8f`): the third
full dogfood cycle, executed and closed under the goal loop itself. This document grounds every
claim in the run's own ledger (`.opencode/goals/ship-v031-launch-experience/ledger.jsonl`),
evidence directory and pty captures; defects are filed with their CLEO task ids.

## 1. What this run set out to fix

The v0.3.0 run proved the feedback loop end-to-end but ended with five launch-experience
defects observed LIVE by the owner: a command palette listing zero Goal commands (T064), an
owner-approved launch refused by `goal_start` (T068, observed starting this very contract),
decision dialogs that never reached the owner as usable options (T066), a complete decision
offering only Archive (T067), and no clean-start path, start picker or priority ordering
(T059/T060/T061). The contract locked 19 criteria; every new command check started as a
committed red stub (rehearsal baseline: all command checks red, honestly — see
`evidence/10a52d01a001/rehearsal.json`).

## 2. The launch of this run was itself the first defect

The owner picked the recommended launch option and `goal_start` still refused — three root
causes, fixed in-run as T068 (`83bf228`): byte-exact label matching (the skill's own
"(Recommended)" suffix broke it), in-memory-only approval (two server restarts voided it), and
a generic refusal that could not say which check failed. Separately, the owner's typed
`/goal start` sat ~9 minutes in the composer queue behind an active turn with zero feedback
("I sent it but nothing happened") — filed as **T069** (silent command deferral; not in this
release). The workaround that started this run: the byte-exact label, learned from the engine
source.

## 3. The palette defect and the pty gate (C1, T064)

Diagnosis proceeded by instrumentation, then source: marker writes proved setup/render/layer
registration all ran, so the layer registered but never became *reachable*. Upstream source
(anomalyco/opencode @ v2.0.22) showed why: a keymap layer without an explicit `mode` defaults
to `mode:"base"`, and the command palette itself registers `mode:"modal"` — base layers are
unreachable while any modal is open. The fix is one line (`mode: "global"`, matching the
host's own palette layer, `fdba1bb`) and was proven by pty A/B under identical probe
parameters: mode-global listed all Goal commands, mode-less listed none. Recorded as spike
S25.

The A/B demanded a deterministic capture, which became the shippable gate:
`scripts/tui-smoke.ts --assert` boots an isolated host, attaches a real TUI in a pty, drives
the blocked decision dialog (3 scripted `goal_block` turns) and the palette, and asserts six
claims — dialog opens, choice rows visible, screen-fit (title row 14, choices rows 18–19 of
50), Enter wired to a real `rpc.act` resume (the engine left `blocked`), palette opened, ≥6
Goal commands listed. Green 5/5 runs total (3/3 determinism re-runs, plus the final
regression and release runs). Two infrastructure findings shaped it and are recorded as
spikes: OpenCode 2.0.22's TUI **stops draining pty input during event churn** (a 1-byte write
blocked ~170 s; the gate drives keys only against an idle engine — S26), and flat-text
captures merge cursor-addressed regions, so the gate reconstructs a 50×180 VT screen model to
judge bounds (S27's sibling lesson, in `spikes/pty-gate.py`).

## 4. Launch, picker, priority, decisions (C2–C10)

- **Clean start (T059, `5d57a27`)** — `/goal start <slug> fresh` creates a new session owned
  by the goal, pins the run to it (T049 interplay covered by the scenario: the run map keys
  the NEW session) and prompts the kickoff there; a `clean-start` ledger event records
  from→to. The skill's launch ask now offers three launch options with accurate copy.
- **Start picker (T060, `c7e3a1d`)** — no-arg `/goal start` became an act-able dialog over
  startable goals (title + validation state), empty state offering `/goal new`; wired through
  the T050 decision machinery with a new `start` act. The composer-completions spike verdict
  (S27): **OpenCode 2.0.22 exposes no dynamic command-argument completions** —
  `CommandDefinition` is `{name, description?, execute}` — so the dialog is the surface.
- **Priority (T061, `4d0f0fd`)** — optional `low|medium|high` through the validator, run state
  and registry (`byPriorityThenRecency`, absent last), sorting `/goal list`, the palette's
  rpc.list and the picker; the interview asks for priority only when a live goal exists.
- **Decision trail + sequencing (T066, `2dd06ca`)** — every `decide()` ledgers an emission
  (decisionId, kind, message, choices) and the owner's answering act pairs a
  `decision-resolved` row; on the wire the decision fires before the summary, and the TUI
  queues the summary digest behind an open decision dialog instead of burying it.
- **Complete decision (T067, `e68f1ff`)** — "Start the next goal" is a `start-next` act that
  dispatches the write-goal interview into the session (ledgered per T066); guidance-only
  choices render as visible rows (`ℹ`-prefixed) instead of being dropped; the needs_review
  copy states that approving triggers verification of everything else.

## 5. Housekeeping and wrap-up (C11–C13)

`verifierTimeoutMs` is now the PER-ROUND budget — 240 s default, up from total/2 = 120 s per
round (the two provider hangs of the last run each burned a 120 s round; `f85a5e9`), and
config-overridable through plugin options. **T024 closed**: all 18 child acceptance criteria
bound to their children's own verified evidence chains (commit+files atoms from T025–T058),
the suite green at binding time. Both finished dogfood runs (`dogfood-buildout`,
`ship-v03-feedback-loop`) sit in `.opencode/goals-archive/` with ledger and evidence intact
(`d7fc2c7`).

## 6. The release (C14–C16)

v0.3.1 bumped (`496f8b5`), CHANGELOG entry written, tagged and pushed; the git-install test
against the pushed tag passes (4 expects — the TUI runtime resolves in the installed cache).
The full suite stood at **150 pass / 0 fail / 1 skip** on the release commit, typecheck green.

## 7. This run's own verification evidence

The engine's live checks passed C1 (the pty gate) and C16 (git-install) during the run; the
completing round under the reinstalled v0.3.1 runs the rest. Its real verifier artifact:

<!-- VERIFIER-EVIDENCE: filled from the completing round under the installed v0.3.1 -->

## 8. Defects filed from this run

- **T068** — launch approval: byte-exact label, in-memory state, undiagnosable refusal (fixed
  in-run, `83bf228`).
- **T069** — `/goal` commands sit silently in the composer queue behind an active turn/form;
  the owner sees nothing until it lands (filed; candidate for v0.3.2 — not this release).
- Upstream observations recorded as spikes S25 (keymap layer modes), S26 (pty input
  starvation under churn), S27 (no dynamic command-argument completions).

## 9. Cost and cache observations

Base context 156,299 tokens at start; the run's engine-side usage counters (in `run.json`)
carry the per-turn accounting. The verifier child's model resolution and empty-round retry
behavior (T044) were exercised by the completing round under v0.3.1; see §7.
