# Research behind opencode-goal

Collected 2026-10-02 while designing the plugin. Read them in this order.

| File | What it is |
|---|---|
| [landscape.md](landscape.md) | The verdict: OpenCode 2 plugin facts, teardown of the two reference plugins, what prior art says, the gaps this project fills. Start here. |
| [opencode2-plugin-api.md](opencode2-plugin-api.md) | Cited reference of the OpenCode 2.0.22 plugin system (server hooks, events, sessions, tools, commands, TUI slots, RPC, skills, the `question` tool), every fact tagged VERIFIED-SOURCE / VERIFIED-DOCS / INFERRED with path:line at tag v2.0.22. Section 0.6 is an addendum. |
| [wr-goal-teardown.md](wr-goal-teardown.md) | Line-cited teardown of william-ricchiuti/OpenCode-goal-plugin v0.11.0: architecture, data model, loop, completion, V2 bridge, CHANGELOG lessons, steal/avoid lists. |
| [prior-art.md](prior-art.md) | Codex `/goal`, Claude Code `/goal` and ralph-loop, Huntley's Ralph, oh-my-openagent, six other OpenCode goal plugins (bybrawe, pw, js, loopd, bm, goalx), long-horizon research, and goal-writing interview methods (Pocock grilling, spec-kit clarify, Kiro EARS, BMAD, define-goal). Ends with the 12 ideas most worth stealing. |
| [../spikes.md](../spikes.md) | What OpenCode 2.0.22 actually did when probed (S1-S9). Where it disagrees with any doc, the spike wins. |

## Primary sources

- OpenCode: https://github.com/anomalyco/opencode (tag `v2.0.22`, commit 527f0b9); V1 docs https://opencode.ai/docs/plugins/ ; V2 docs https://opencode.ai/v2/docs/build/plugins
- Reference plugins: https://github.com/william-ricchiuti/OpenCode-goal-plugin (v0.11.0), https://github.com/martsallan/goal-opencode (v0.3.1, OpenCode 1.x only — does not load on 2.x)
- Kimi Code (MoonshotAI), referenced for the write-goal skill and headless goal mode — not copied here:
  - write-goal skill: https://raw.githubusercontent.com/MoonshotAI/kimi-code/refs/heads/main/packages/agent-core-v2/src/features/skill/catalog/builtin/write-goal.md
  - headless goal prompt and exit codes: https://github.com/MoonshotAI/kimi-code/raw/refs/heads/main/apps/kimi-code/src/cli/goal-prompt.ts
  - CLI options: https://github.com/MoonshotAI/kimi-code/raw/refs/heads/main/apps/kimi-code/src/cli/options.ts
- Codex `/goal` source: https://github.com/openai/codex (`codex-rs/ext/goal/`); Claude Code `/goal` docs: https://code.claude.com/docs/en/goal

What we took from Kimi's write-goal: "ask, don't narrate" (every choice through the ask tool), proof not effort, the five-part contract (end state, proof, boundaries, loop, stop rule), queue-shaped goals, budgets opt-in and framed on tokens, show the exact contract before starting, respect the owner's final call. From its headless mode: exit codes `complete → 0`, `blocked → 3`, `paused → 6` and a `goal.summary` JSON line (planned for our headless runner).
