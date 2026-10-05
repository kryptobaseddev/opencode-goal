// Starts an isolated host with this plugin and a goal that stalls into a paused
// state, then holds it so a real TUI can attach (python3 spikes/tui-capture.py).
//
// --assert: the v0.3.1 deterministic pty gate (goal ship-v031-launch-experience C1),
// EXTENDED for v0.3.2 (ship-v032-trust-the-card C1):
//   v0.3.1 (kept): Goal commands appear in the palette probe, dialogs render
//     within screen bounds, decision rows are visible + keyboard-selectable.
//   v0.3.2 (a): after the run settles, the sidebar card shows the completing
//     status (T072's live proof — no stale snapshot survives the churn).
//   v0.3.2 (b): the panel opens (leader+g) and cycles its tabs (T074's pty
//     walkthrough).
// Boots a real TUI against the isolated host and exits 0 only when every
// assertion passes. The gate flow:
//   1. the pty TUI attaches BEFORE the goal starts (so it sees every engine
//      event); the scripted worker makes progress, then blocks the goal with
//      3 consecutive goal_block reports; the engine emits the "blocked"
//      decision payload; the TUI renders it as a keyboard-selectable dialog
//      (spikes/pty-gate.py asserts the render and presses Enter → rpc.act
//      resume).
//   2. the resumed worker drives the run to a completing claim (write
//      done.txt, steps done, goal_claim; the verifier proves C3) — the run
//      COMPLETES; the gate dismisses the decision/summary dialogs and
//      asserts the sidebar card shows complete + the loop-stopped line.
//   3. leader+g opens the dashboard panel; the gate cycles the tabs and
//      asserts the highlighted tab moves; then the palette is probed.
// The orchestrator asserts the engine actually left "blocked" and reached
// "complete" on disk, and prints one PASS/FAIL summary; exit 0 iff all green.
import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { goalHost, newSession, script, waitStatus } from "../test/host/goal.helpers"

if (process.argv.includes("--assert")) {
  // Fresh phase artifacts: a stale gate-palette.txt from a previous run would
  // release the worker's blocking phase before the palette was ever probed.
  const spikesDir = join(import.meta.dir, "..", ".tmp", "spikes")
  await mkdir(spikesDir, { recursive: true })
  for (const stale of ["gate-palette.txt", "gate-dialog.txt", "gate-full-flat.txt", "gate-card-complete.txt", "gate-panel-*.txt"])
    await Bun.file(join(spikesDir, stale)).delete().catch(() => {})
  // Deterministic scheduling against the engine's own rules:
  //  - stall detector: 3 consecutive no-progress turns pause the run, so the
  //    first turns make real progress (goal_progress step changes);
  //  - blocker repeats need 3 CONSECUTIVE turns reporting the same key, and
  //    the blocked decision must land while the pty TUI is attached;
  //  - after Enter resumes the run, the worker COMPLETES the goal (T072's
  //    live leg): write done.txt, mark the steps done, claim — the verifier
  //    proves C3 and the run settles complete.
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
  let claimed = false
  const host = await goalHost(
    script(
      async (_req, turn) => {
        if (turn.results === 0) turns++
        // the completing leg: after the gate's Enter resumes the run, finish
        if (turn.trigger.includes("resumed")) {
          if (turn.results === 0 && !claimed) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok - gate\n" } }], delayMs: 300 }
          if (turn.results === 1 && !claimed) return { toolCalls: [{ name: "goal_progress", args: { step: "S3", step_done: true, note: "gate completing leg" } }], delayMs: 300 }
          if (turn.results === 2 && !claimed) {
            claimed = true
            return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence: { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" } } }], delayMs: 300 }
          }
        }
        if (turn.results === 0 && turns === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", note: "gate setup" } }], delayMs: 300 }
        if (turn.results === 0 && turns === 2) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "gate setup" } }], delayMs: 300 }
        if (turn.results === 0 && turns === 3) return { toolCalls: [{ name: "goal_progress", args: { step: "S2", step_done: true, note: "gate setup" } }], delayMs: 300 }
        if (turn.results === 0 && turns === 4) return { toolCalls: [{ name: "goal_progress", args: { step: "S3", step_done: true, note: "gate setup" } }], delayMs: 300 }
        if (turn.results === 0 && blocks < 3) {
          blocks++
          return { toolCalls: [{ name: "goal_block", args: { key: "tui-gate", reason: "the pty gate drives the blocked decision dialog", needs: "decision" } }], delayMs: 600 }
        }
        return { text: "Blocker resolved; the gate is only asserting surfaces." }
      },
      () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states it", evidence: [{ path: "done.txt", quote: "status: ok - gate" }] }] } }] }),
    ),
    { ".opencode/goals/demo/goal.yaml": THREE_STEP_GOAL },
  )
  const sessionID = await newSession(host)
  const out = join(import.meta.dir, "..", ".tmp", "spikes")
  await mkdir(out, { recursive: true })
  await writeFile(join(out, "tui-host.json"), JSON.stringify({ url: host.url, sessionID, project: host.project, env: host.env, password: host.password }, null, 2))

  // Attach the pty TUI first, then start the goal: every engine event —
  // including the blocked decision and the completing transition — is
  // rendered from a live attachment.
  const gate = Bun.spawn(["python3", join(import.meta.dir, "..", "spikes", "pty-gate.py")], {
    cwd: join(import.meta.dir, ".."),
    stdout: "inherit",
    stderr: "inherit",
  })
  await Bun.sleep(4000) // let the TUI boot and render the session
  await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)

  const ptyExit = await gate.exited
  let finalState: { status?: string } | undefined
  try {
    finalState = (await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 60000)) as { status?: string }
  } catch {
    finalState = undefined
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
  const statusAfter = finalState?.status
  const leftBlocked = statusAfter !== undefined && statusAfter !== "blocked"
  console.log(`ASSERT engine.left-blocked ${leftBlocked ? "PASS" : "FAIL"} status after Enter = ${String(statusAfter)}`)
  const reachedComplete = statusAfter === "complete"
  console.log(`ASSERT engine.reached-complete ${reachedComplete ? "PASS" : "FAIL"} final status = ${String(statusAfter)}`)

  await host.stop()
  const pass = ptyExit === 0 && leftBlocked && reachedComplete
  console.log(`TUI-SMOKE-ASSERT ${pass ? "PASS" : "FAIL"} (pty gate exit ${ptyExit})`)
  process.exit(pass ? 0 : 1)
}
// the plain hold-mode host for manual captures follows

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
