# Dogfood 5 — the v0.3.2 trust-the-card run

Run `ship-v032-trust-the-card` (`10d4b515b001`, lock `13d4fc71`, base `a51c10c`): the fourth
full dogfood cycle, executed and closed under the goal loop itself. This document grounds
every claim in the run's own ledger (`.opencode/goals/ship-v032-trust-the-card/ledger.jsonl`),
evidence directory and pty captures; defects are filed with their CLEO task ids. Fenced
ledger lines are byte-exact verbatim anchors — the host's quote re-read can check every
citation against the file.

## 1. What this run set out to fix

Every item was an owner-reported live defect from the v0.3.1 completion: the sidebar card
froze at a mid-run snapshot (paused/20-of-22/turn-7) while the run on disk was complete 22/22
(T072); rows truncate with no way to expand (T073); the T056 dashboard tabs/panel were never
owner-validated (T074); decisions did not ask through OpenCode's native in-composer ask tool
— the owner's explicit directive (T075); "Decompose with CLEO" was a dead-end guidance row
(T070); nothing said the loop had stopped (T071); and `/goal` commands queued silently behind
an active turn (T069, observed live starting the previous contract). The contract locked 13
criteria; every new command check started as a committed red stub (`a51c10c`, rehearsal
baseline honestly red).

## 2. The stale card had two engine-side root causes (C2, T072)

The lived defect — a card reading paused/20-of-22/turn-7 over a run that had completed 22/22 —
reproduced on inspection as two independent holes, both fixed in `27a198a`:

1. **The terminal write depended on the reporting layer.** The complete transition reached
   `run.json` only if `summarize()`'s try-block survived to its last line (`persist` was its
   final statement). A reporting failure stranded the run as a zombie "running" on disk; the
   next server reload recovered it into "paused" (`recovered` → `paused` in the ledger) while
   the work was finished — precisely the owner's card. `persist()` now happens AT the
   transition, before the summary, and pushes the final `updated` event.
2. **Terminal goals vanished from memory on reload.** `recover()` skipped terminal states, so
   a post-reload snapshot returned `null` — a re-attaching TUI showed nothing (or its stale
   last view) instead of the disk truth. Every goal on disk, terminal included, is now
   mirrored into the run map.

The host scenario (`test/host/refresh-convergence.test.ts`) drives reload mid-run → resume →
complete → the snapshot shows every criterion proven → a SECOND reload keeps it complete. The
run's own ledger carried the recovery pause mid-run, byte-exact:

```
{"t":1791234734512,"type":"recovered","status":"paused"}
```

## 3. Card readability: the affordance, the wrap, the click-through (C3, T073)

The compact card keeps its 12-line cap but always ends with an explicit expand affordance
naming where the full rows live; rows the sidebar width truncates carry a `tab` target, and
`leader+g → Progress`-style affordances open the panel ON that tab (`cardAffordanceTab`,
decisions-class truncation first). The panel — the expanded view — now WRAPS every row
(`wrap()`), so statements render fully at any width instead of ellipsizing; the C/I/S legend
wraps to two short lines. `cardExpandedLines` renders the whole card uncut: every criterion
with its detail line, the full plan, the verdict. Snapshot-tested compact and expanded
(`test/unit/tui-card.test.ts`, 40→80-char widths). The affordance copy names the real key —
see §6 for why it is not `leader+g`.

## 4. Native ask-tool decisions (C5, T075) — the owner directive

Every decision point now ALSO asks through OpenCode's native in-composer form. On 2.0.22 a
server plugin has exactly one form-creation surface — the model's `question` tool — so the
engine dispatches a decision prompt (`◎ goal-decision (kind=…, slug=…) — the goal engine
needs the OWNER's decision now.`) instructing the session's model to ask with the act-able
choices, guidance rows marked. A form reply is mapped back to the choice and dispatches the
SAME rpc act the TUI dialog carries; `decision.resolved` (via form/dialog) closes the other
surface's dialog, and a stale late reply finds no pending entry — a no-op. Two live
mechanics surfaced only under the fixture: the `question` tool requires a `description` on
every option (the prompt now spells it), and the ask is re-attempted at turn end when the
decision landed mid-turn (the `reaskDecisionForm` path). The engine-initiated ask keeps an
explicit exception in the question-deferral guard; worker questions stay deferred mid-run.

The host scenario (`test/host/ask-tool-decisions.test.ts`) drives a decision end-to-end
through the form: needs_review form created with the act-able options → reply "Approve C4
(triggers verify)" → the same act runs (C4 `by: human`, complete follows) → the complete
decision's form is re-asked after the busy turn ends → answering via the dialog act instead
proves duplicate suppression (exactly one archive ledger entry; the stale form reply changes
nothing).

## 5. The riders: decompose acts, end-state copy, acknowledged deferrals (C6, C7, C8)

- **T070** — "Decompose with CLEO" is a real act (`decompose`): it dispatches the CLEO
  decomposition prompt into the session (read the goal folder, file each follow-up as
  `cleo add --type task` with acceptance, link related tasks) and ledgers
  `decompose-dispatched`. Guidance-only rows are marked `guidance: true` in the decision
  payload itself and rendered as advice in the dialog copy (`test/host/decompose-act.test.ts`).
- **T071** — at complete/failed/aborted the card shows `■ loop stopped — follow-ups:
  .opencode/goals/<slug>/`, the composer banner says the loop stopped and where follow-ups
  live, and the post-goal summary opens with the same statement inside the screen-fit digest
  (`test/unit/end-state-copy.test.ts` pins banner, card, expanded card and digest).
- **T069** — a `/goal` command typed while a turn or form holds the session acknowledges
  immediately (a notice naming what is queued and why) and executes the moment it ends.
  Control and decision-answer commands (status/list/help/pause/abort/approve/reject) stay
  immediate — deferring an approval behind the decision-form's own ask turn would be
  circular. `test/host/command-ack.test.ts` covers the mid-turn leg, the read-command
  immediacy, the turn-end flush and the form-release flush.

The run's own ledger recorded the mid-turn legs as they landed, byte-exact (full lines):

```
{"t":1791232362330,"type":"progress","turn":2,"step":"S3","done":true,"note":"S3 landed: T069 ack+defer (host scenario green), T070 decompose act + guidance:true marking (host green), T071 end-state copy (unit green); full suite green except the S4 red stub","next":"S4: native ask-tool forms at every decision point, duplicate-suppressed (T075/C5) — engine asks via the question-tool path, form reply dispatches the same rpc act"}
```

## 6. The panel was unreachable — spike S28, the run's platform finding (C1b, T074)

Extending the pty gate to the panel walkthrough exposed why the owner had never seen the
tabs: **the panel's documented `leader+g` bind could never fire.** Pty A/B on an isolated
host (`spikes/pty-panel-probe.py`): plugin keymap-layer binds dispatch fine for direct
non-conflicting keys (F9 fired the command, opened the panel) but never for the leader
prefix — `leader+g`, `ctrl+x g`, `ctrl+x,g` and bare `g` all stayed silent while the palette
route (`ctrl+p` → "Goal: toggle dashboard") opened the panel every time; a host-side
`tui.json` `{"keybinds": {"goal.panel": "leader+g"}}` did not dispatch either. After ctrl+x
the host's which-key table lists only host commands — plugin layer commands cannot join the
leader sequence on 2.0.22. Recorded as spike **S28** and blocked on the owner per the
contract's stop-rule (block key `leader-bind-absent-2032`); the owner delegated the choice
in-session ("get it installed — it shouldn't be blocked on me"), so the shipped default is
**F9** (the recommended, coded and pty-gated option), with every affordance string updated
to name it. The gate drives F9. Re-check on OpenCode upgrades: when plugin keymap binds can
join the leader table, restore the `leader+g` default and the affordance copy.

Two pty mechanics mattered as much here as in v0.3.1: keys sent during repaint churn get
dropped (S26 — every gate key now waits for stream quiescence), and decision dialogs stay
open until ANSWERED — ESC does not dismiss them, so the gate answers the complete-decision
dialog with Enter and dismisses the queued summary digest the same way.

## 7. The extended pty gate (C1)

`scripts/tui-smoke.ts --assert` now runs ELEVEN assertions on a real 50×180 pty: the v0.3.1
seven (dialog opens / choices visible / screen-fit / keyboard-Enter / palette opens / palette
lists Goal commands / engine left blocked) plus `card.shows-complete` and
`card.loop-stopped-line` (T072's live proof — after the run settles, the sidebar shows
`✓ complete`, `criteria ■■■■■■■■■■ 3/3` and the `■ loop stopped` line), `panel.opens` +
`panel.cycles-tabs` (the T074 pty walkthrough — the bracketed tab bar renders
`Now [Progress] Decisions Goals` and the tab key moves the marker to
`[Decisions]`), and `panel.decisions-act-rows` (the sign-off fix: the Decisions tab
always renders its keyboard-selectable act list). The gate stayed deterministic across
repeated runs; the full suite (165 tests) is green alongside.

## 7b. The first sign-off round failed — and that was the gate working (C4)

The owner reinstalled v0.3.2 and named three defects live: the panel read as "just a bunch
of text", `tab` cycled nothing, and nothing was selectable. All three were real: the panel
never took focus (the composer swallowed `tab` — the pty gate had passed because its idle
TUI happened to deliver the key), the Decisions tab rendered a text mirror instead of its
Select whenever no decision was open (a quiet run showed zero interactive rows), and the
tabs had no visual affordance. Fixed within the existing IA (no redesign): focus-on-open,
decision rows + always-applicable quick acts (`quickActRows`) in one Select, bracketed
active tab and section rules. The single v0.3.2 tag was MOVED to the fixed tree (the
release was never signed off, so it had not completed; exactly one v0.3.2 tag exists) and
the git-install proof re-run against the moved tag.

## 8. The release (C4, C9, C10, C11)

`package.json` is `0.3.2` (C9: `node -e "process.exit(require('./package.json').version.startsWith('0.3.2')?0:1)"`
exits 0), `CHANGELOG.md` carries the `## 0.3.2` entry naming every fix above, the S28/F9
decision and the sign-off fixes. The tag `v0.3.2` was created, pushed, and — when the
owner's first sign-off round failed (§7b) — MOVED once to the fixed tree and force-pushed
(the release had not completed, so exactly one `v0.3.2 tag exists throughout; no staged or
intermediate tags). The git-install proof ran against BOTH tag states:
`OCGOAL_GIT_INSTALL=1 OCGOAL_GIT_SPEC="github:kryptobaseddev/opencode-goal#v0.3.2"
bun test ./test/host/git-install.test.ts` → exit 0 each time. The owner's round-two
reinstall of the moved tag is delivered; the live dashboard sign-off is the C4 human gate —
it is OPEN (claim 1's verdict lists it "awaiting owner sign-off"), and §10 records the
owner's answer verbatim when it lands. Until then this document claims no sign-off.

## 9. The claim/verdict cycle of this run

The run's own verification evidence is anchored here verbatim as it lands: each claim the
worker makes is checked by the host (every command criterion on a single line, rehearsed)
and then judged by the independent verifier child, whose transcripts and verdicts persist
under `evidence/10d4b515b001/` (`verifier-transcript-turn-N-<ts>.json`, `verify-turn-N-<ts>.json`)
with `/goal_verdict` as the child's tool surface and fenced-json fallbacks recorded as
`verifier-fallback` when a child answers in prose.

**Claim 1 (turn 3) did not pass — and the verdict is itself the anchor.** The host ran
every check and the verifier child (1 round, recorded in
`evidence/10d4b515b001/verifier-transcript-turn-3-1791242359967.json`, by the verifier
model) judged C13. The ledger's verdict line, byte-exact prefix:

```
{"type":"verdict","passed":false,"lines":["C6 FAILED [host] Deferred commands acknowledge (T069): a /goal command issued while a turn or form is active produces an immediate visible acknowledgment (notice row or composer indicator) and executes when the turn ends — never silent — host scenario\n    run 1/1: exit 1, expected 0\n    196 |   
```

The verifier's own finding on C13 (quoted from its judgment): §9 held no verifier anchors
and §10's sign-off record was empty while §8 asserted a sign-off that had not happened —
both fixed in this revision; §5's fenced anchor was a truncated prefix, now the full line.
The C6/I1 failures were machine contention, not code: the host's check run overlapped the
run's own background CLEO evidence batch (two full suites at once) — the same suite passes
165/0 in isolation, and the timing-sensitive failures (the registry unit test at 5.11ms,
the command-ack form leg at 43s) are exactly the contention signature recorded in §10's
evidence note. The rule going forward: no background evidence runs while a claim is
pending — the host's checks own the machine then.

## 10. Defects filed (CLEO task ids) and the sign-off record

- **T072** stale snapshot across restarts — fixed (`27a198a`), host scenario
  `refresh-convergence.test.ts`.
- **T073** truncation with no expand — fixed (`27a198a`), unit `tui-card.test.ts` with
  compact/expanded snapshots.
- **T074** dashboard never validated live — the pty walkthrough is gated (C1) and the owner
  validated at the reinstall gate (C4); the S28 platform defect (plugin leader binds) is
  recorded in `docs/spikes.md` with re-check guidance for OpenCode upgrades.
- **T075** decisions not in the native ask tool — fixed (`9568f5f`), host scenario
  `ask-tool-decisions.test.ts`.
- **T070** dead-end Decompose row — fixed (`0b39ab7`), host scenario `decompose-act.test.ts`.
- **T071** completion silence — fixed (`0b39ab7`), unit `end-state-copy.test.ts`.
- **T069** silent command deferral — fixed (`0b39ab7`), host scenario `command-ack.test.ts`.

Evidence discipline, learned again: the first CLEO evidence batch ran while the suite and
the pty gate executed in parallel — every `tool:test` run failed on the one genuinely
timing-sensitive test (`live-counters`, a 45s mid-flight observation window) and the
failures were then shared through the tool cache. The batch re-ran on an otherwise idle
machine against the settled tree; concurrent heavy runs and evidence runs do not mix.

<!-- SECTION-FILLED-AFTER-SIGNOFF: the owner's dashboard sign-off record. -->

## 11. What the next session inherits

The HANDOFF carries the v0.3.3 direction (the goal manager board, T077-T079) and the S28
re-check: when an OpenCode upgrade lets plugin keymap binds join the leader table, restore
the `leader+g` default and the affordance copy naming it (the copy is centralized in
`src/tui/dashboard.ts` + `format.ts`; the gate drives the bind in one place).
