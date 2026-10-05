# Handoff — opencode-goal

Written 2026-10-02, refreshed through **2026-10-06 (v0.3.1)** across five dogfood runs
(`0ffe5ac6e001`, `10388d06d001`, `ship-v03-feedback-loop`, `dogfood-buildout`, plus
`ship-v031-launch-experience` — the v0.3.1 launch-experience run whose completing claim is
gated on the owner reinstall). Read this first, then `AGENTS.md` (project guide below the CLEO
block), then [design.md](design.md). Observed OpenCode behaviour: [spikes.md](spikes.md)
(trust it over any doc).

## 1. Where things stand

| | |
|---|---|
| Repo | https://github.com/kryptobaseddev/opencode-goal (public, MIT), local `~/projects/opencode-goal` |
| Released | **v0.3.1** (`496f8b5`, tagged, pushed, git-install-proven). The launch-experience release: live palette behind a deterministic pty gate (`scripts/tui-smoke.ts --assert`), launch-approval robustness (prefix labels, restart-durable, diagnosable refusals), Start clean, the start picker, low/medium/high priority end-to-end, decision ledger + decision-first/summary-digest sequencing, complete-decision start-next + guidance rows, 240s verifier rounds. Full entry in [CHANGELOG.md](CHANGELOG.md). |
| Installed | The owner's OpenCode pins `#v0.3.0` as of writing — **the v0.3.1 reinstall is pending** (the engine-version gate; see §4). |
| Dogfood run `ship-v031-launch-experience` | Run `10a52d01a001`, lock `19fcd8af`. **21/23 criteria host-proven**; C17 (dogfood-4 evidence quote — the doc's §7 now carries the verifier child's verbatim judgment) and C18 (the verifier's fresh groundedness judgment) resolve at the completing claim. Both prior runs (`dogfood-buildout`, `ship-v03-feedback-loop`) archived with history intact. Findings: [dogfood-4.md](dogfood-4.md). |
| Tests | **150 pass / 0 fail / 1 skip** (`bun test`, ~100 s) at the release commit; typecheck green. All eight v0.3.1 red stubs became real suites. |
| CLEO | **T024 (v0.3 epic) done** — all 18 child ACs bound to their children's evidence. T059–T068 all complete. **T069** filed (slash commands queue silently behind an active turn — the "I sent it but nothing happened" experience); candidate for v0.3.2. |
| Docs | [design.md](design.md) · [dogfood-1.md](dogfood-1.md) · [dogfood-2.md](dogfood-2.md) · [dogfood-3.md](dogfood-3.md) · **[dogfood-4.md](dogfood-4.md)** · [spikes.md](spikes.md) (S25 keymap modes, S26 pty input starvation, S27 composer-completions verdict) |

## 2. Owner intent

Goal mode + write-goal skill for OpenCode 2, host-verified completion, installed from git tags
and iterated like a real user; CLEO as the decomposition source of truth; council reviews for
design decisions. v0.3.1 was "everything 100% ready to push as a launch release" — shipped.

## 3. What remains for the current run

1. The owner reinstalls: `opencode plugin remove "github:kryptobaseddev/opencode-goal#v0.3.0"`
   → `opencode plugin add "github:kryptobaseddev/opencode-goal#v0.3.1"` → `opencode reload`.
2. Resume the goal → the completing claim (goal_claim) → C17 re-checks host-green, C18's
   verifier judges the filled dogfood-4 → complete → `/goal archive ship-v031-launch-experience`
   when ready.
3. Next board: T069 (silent command deferral) and whatever the first real v0.3.1 use surfaces.

## 4. Lessons from this run (all in dogfood-4)

- The palette defect was keymap-layer **mode-scoping**: plugin layers default `mode:"base"` and
  are unreachable under the palette's `mode:"modal"` layer — `mode:"global"` is the fix (S25),
  gated ever since by the deterministic pty smoke.
- OpenCode 2.0.22's TUI **stops draining pty input during event churn** (a 1-byte write blocked
  ~170 s; S26) — keystroke-driven checks must target an idle engine. The pty gate also needs a
  real VT screen model: flat-text flattening merges cursor-addressed regions (S27 sibling).
- The launch of this run WAS the first defect: byte-exact label matching + in-memory approval
  + generic refusal (T068, fixed). T069 (silent command queueing) remains open.
- CLEO evidence: workspace-wide change sets reject scoped test-run atoms — bind `tool:test`
  when the whole suite is green (batch task completions at the end). T024's child-ACs bind
  with each child's own commit+files atoms.
- Never discard typecheck output — a `>/dev/null` hid a test-file type error until CLEO's
  `tool:typecheck` atom caught it.

## 5. Releasing (the owner's iteration loop — unchanged)

Bump `package.json` + `CHANGELOG.md` → commit `type(T###)` → `git tag -a vX.Y.Z` →
`git push origin main --follow-tags` → git-install test against the tag → owner reinstalls
(`plugin remove` old, `plugin add` new, `reload`) → verify with `opencode plugin list` or the
npm cache (`~/.cache/opencode/npm/git-opencode-goal-<hash>/<epoch>/package.json` pins the
spec; newest epoch wins). The owner's OpenCode runs the **installed tag**, not this working
tree.
