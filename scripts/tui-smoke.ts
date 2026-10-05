// Starts an isolated host with this plugin and a goal that stalls into a paused
// state, then holds it so a real TUI can attach (python3 spikes/tui-capture.py).
//
// --assert: the v0.3.1 deterministic pty gate (goal ship-v031-launch-experience C1).
// Boots a real TUI against the isolated host and exits 0 only when: Goal commands
// appear in the palette probe, dialogs render within screen bounds, and decision
// rows are visible + keyboard-selectable. Implemented by plan step S1 (T064).
import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { goalHost, newSession, script, waitStatus } from "../test/host/goal.helpers"

if (process.argv.includes("--assert")) {
  console.error("tui-smoke --assert: pty gate not implemented yet — red stub (v0.3.1 plan S1, T064)")
  process.exit(1)
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
