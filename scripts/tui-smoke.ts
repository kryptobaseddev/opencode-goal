// Starts an isolated host with this plugin and a goal that stalls into a paused
// state, then holds it so a real TUI can attach (python3 spikes/tui-capture.py).
//
// --assert: the v0.3.1 deterministic pty gate (goal ship-v031-launch-experience C1).
// Boots a real TUI against the isolated host and exits 0 only when: Goal commands
// appear in the palette probe, dialogs render within screen bounds, and decision
// rows are visible + keyboard-selectable. The gate proves three live defects
// fixed on a real pty (T064 palette mode, T065 screen-fit, T066 decision
// rendering) — the harness rpc boundary alone never caught them.
//
// Gate flow: the pty TUI attaches BEFORE the goal starts (so it sees every
// engine event); the scripted worker then blocks the goal with 3 consecutive
// goal_block reports; the engine emits the "blocked" decision payload; the TUI
// renders it as a keyboard-selectable dialog (spikes/pty-gate.py asserts the
// render and presses Enter → rpc.act resume); finally the palette is probed.
// The orchestrator asserts the engine actually left "blocked" (Enter was
// wired to a real act) and prints one PASS/FAIL summary; exit 0 iff all green.
import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { goalHost, newSession, script, waitStatus } from "../test/host/goal.helpers"

if (process.argv.includes("--assert")) {
  // Fresh phase artifacts: a stale gate-palette.txt from a previous run would
  // release the worker's blocking phase before the palette was ever probed.
  const spikesDir = join(import.meta.dir, "..", ".tmp", "spikes")
  await mkdir(spikesDir, { recursive: true })
  for (const stale of ["gate-palette.txt", "gate-dialog.txt", "gate-full-flat.txt"]) await Bun.file(join(spikesDir, stale)).delete().catch(() => {})
  // Deterministic scheduling against the engine's own rules:
  //  - stall detector: 3 consecutive no-progress turns pause the run, so the
  //    first turns make real progress (goal_progress step changes);
  //  - blocker repeats need 3 CONSECUTIVE turns reporting the same key, and
  //    the blocked decision must land while the pty TUI is attached.
  // T1-T4 progress every step of the 3-step demo plan; T5-T7 report
  // goal_block — the turn ends BLOCKED, the engine goes quiet and the TUI
  // renders the decision dialog (OpenCode 2.0.22 stops draining pty input
  // under event churn, so the gate drives keys only once the engine idles).
  // Enter (resume) clears the blocker; later turns are plain text and the
  // run settles into the stall-pause the final assertion expects.
  const THREE_STEP_GOAL = `schema: goal/v1
id: demo
title: Demo file says ok
intent:
  verbatim: "make done.txt say ok"
outcome: done.txt exists and states that the status is ok
non_goals:
  - Touching any file other than done.txt
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
  - id: C2
    statement: 'done.txt SHALL contain the line "status: ok"'
    check: {kind: command, run: "grep -q 'status: ok' done.txt"}
  - id: C3
    statement: done.txt states the status in a full line
    check: {kind: verifier, ask: "Does done.txt state that the status is ok in a full line?"}
protect: ["oracle.txt"]
plan:
  - {id: S1, title: Write done.txt, proves: [C1]}
  - {id: S2, title: Check the line, proves: [C2]}
  - {id: S3, title: Verify the wording, proves: [C3]}
`
  let turns = 0
  let blocks = 0
  const host = await goalHost(
    script(async (_req, turn) => {
      if (turn.results === 0) turns++
      if (turn.results === 0 && turns === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", note: "gate setup" } }], delayMs: 300 }
      if (turn.results === 0 && turns === 2) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "gate setup" } }], delayMs: 300 }
      if (turn.results === 0 && turns === 3) return { toolCalls: [{ name: "goal_progress", args: { step: "S2", step_done: true, note: "gate setup" } }], delayMs: 300 }
      if (turn.results === 0 && turns === 4) return { toolCalls: [{ name: "goal_progress", args: { step: "S3", step_done: true, note: "gate setup" } }], delayMs: 300 }
      if (turn.results === 0 && blocks < 3) {
        blocks++
        return { toolCalls: [{ name: "goal_block", args: { key: "tui-gate", reason: "the pty gate drives the blocked decision dialog", needs: "decision" } }], delayMs: 600 }
      }
      return { text: "Blocker resolved; the gate is only asserting surfaces." }
    }),
    { ".opencode/goals/demo/goal.yaml": THREE_STEP_GOAL },
  )
  const sessionID = await newSession(host)
  const out = join(import.meta.dir, "..", ".tmp", "spikes")
  await mkdir(out, { recursive: true })
  await writeFile(join(out, "tui-host.json"), JSON.stringify({ url: host.url, sessionID, project: host.project, env: host.env, password: host.password }, null, 2))

  // Attach the pty TUI first, then start the goal: every engine event —
  // including the blocked decision — is rendered from a live attachment.
  const gate = Bun.spawn(["python3", join(import.meta.dir, "..", "spikes", "pty-gate.py")], {
    cwd: join(import.meta.dir, ".."),
    stdout: "inherit",
    stderr: "inherit",
  })
  await Bun.sleep(4000) // let the TUI boot and render the session
  await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)

  const ptyExit = await gate.exited
  let stateAfterEnter: unknown
  try {
    stateAfterEnter = await waitStatus(host, ["running", "paused", "needs_review", "blocked", "complete"], 30000)
  } catch {
    stateAfterEnter = undefined
  }
  // Ground truth for gate diagnosis: the engine's own ledger, before the
  // temp host (and its files) go away.
  try {
    const entries = (await host.readProject(".opencode/goals/demo/ledger.jsonl")).trim().split("\n")
    console.log(`GATE-LEDGER ${entries.length} entries; last 14:`)
    for (const line of entries.slice(-14)) {
      const e = JSON.parse(line) as Record<string, unknown>
      console.log(`  ${e.type} turn=${e.turn ?? ""} ${String(e.key ?? e.reason ?? e.kind ?? e.status ?? "").slice(0, 70)}`)
    }
  } catch (error) {
    console.log(`GATE-LEDGER unreadable: ${String(error)}`)
  }
  const statusAfterEnter = (stateAfterEnter as { status?: string } | undefined)?.status
  const leftBlocked = statusAfterEnter !== undefined && statusAfterEnter !== "blocked"
  console.log(`ASSERT engine.left-blocked ${leftBlocked ? "PASS" : "FAIL"} status after Enter = ${String(statusAfterEnter)}`)

  await host.stop()
  const pass = ptyExit === 0 && leftBlocked
  console.log(`TUI-SMOKE-ASSERT ${pass ? "PASS" : "FAIL"} (pty gate exit ${ptyExit})`)
  process.exit(pass ? 0 : 1)
}

const host = await goalHost(script(() => ({ text: "I will get to it." })))
const sessionID = await newSession(host)
await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
await waitStatus(host, ["paused"], 60000)
const out = join(import.meta.dir, "..", ".tmp", "spikes")
await mkdir(out, { recursive: true })
await writeFile(join(out, "tui-host.json"), JSON.stringify({ url: host.url, sessionID, project: host.project, env: host.env, password: host.password }, null, 2))
console.log("READY", host.url, sessionID)
await Bun.sleep(Number(process.env.HOLD_MS ?? 45000))
await host.stop()
