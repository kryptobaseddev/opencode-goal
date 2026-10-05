# Context — ship-v0.3-feedback-loop (facts only)

Written 2026-10-04 after recon. Sources: docs/HANDOFF.md (refreshed through v0.2.2), docs/dogfood-2.md,
`.opencode/goals/dogfood-buildout/goal.yaml` (the contract that worked, 18 criteria), cleo briefing,
task acceptance specs T044–T058.

## Board state at start

- Repo: main @ `f470f1e`, clean except: `.opencode/goals/dogfood-buildout/goal.yaml` (the live `/goal
  amend` that closed C15 — needle 0.2.0→0.2.2, owner-approved, needs committing), untracked
  `.cleo/rcasd/*/research` (CLEO runtime), `spikes/palette-probe.py` (pty palette probe, reusable for T056).
- package.json = 0.2.2 (installed tag in the owner's OpenCode = v0.2.2, verified live).
- Dogfood run `10388d06d001` = **complete** (20/21 + C18 owner-approved; C15 closed by live amend).
  Run-closure tasks T012/T017/T018/T022 all done.
- v0.3 board (all pending, none started): T044 T045 T046 T049 T050 T052 T053 T054 T055 T056 T057 T058
  (T044/T049/T055/T057 under epic T002, rest under T024).
- Tests at start: `bun test` baseline recorded separately below (baseline run in progress at draft time).

## Carried-forward lessons from past goals (binding authoring rules)

1. **Engine-version rule** (dogfood-2 §7): the completing verifier round runs the INSTALLED engine.
   The release step must end with the owner reinstalling the new tag BEFORE the completing claim.
2. **Single-line command rule**: every command check is one shell line (folded scalars split loops).
3. **Version-prefix rule** (T055): version criteria use semantic/prefix checks, never exact contains.
4. **Quote any value containing `: `** (the colon class — three live strikes).
5. **Regex without dot-all**: every lookahead must be satisfiable on ONE line; prefer one needle.
6. **CLEO = decomposition source of truth**: plan steps map to task ids; correlation table below.
7. **Single end release** (dogfood A2 precedent): one tag when all criteria are green.
8. **Owner-final is final** — T051 shipped; T057 extends it to host re-checks (in this goal).
9. Dogfood shape: the run's own completion is live proof for engine-level fixes (T044's real proof is
   this goal's own verifier round on the main host, after the owner reinstalls v0.3.0).

## CLEO correlation (plan step → task)

| Step | Task | Step | Task |
|---|---|---|---|
| S1 | T044 | S8 | T052 |
| S2 | T057 | S9 | T053 |
| S3 | T049 | S10 | T058 |
| S4 | T045 | S11 | T056 |
| S5 | T046 | S12 | T055 |
| S6 | T054 | S13 | T024 (release) |
| S7 | T050 | S14 | T024 (closeout) |

## Baseline (recorded 2026-10-04)

- `bun test` at f470f1e (pre-stubs): **82 pass / 1 skip / 0 fail**, 19 files, 70.7 s.
- `bun run typecheck`: clean.
- Full check rehearsal through the login shell (as stored in goal.yaml): C1–C12 red (stubs), C15 red
  (0.2.2), C17 red (tag absent), I2 clean, I1 red-by-design (stubs). Nothing unrunnable.
- bun exits 0 for a test filter matching no files → new-file checks need committed red stubs (they exist).
