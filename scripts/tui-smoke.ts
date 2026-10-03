// Starts an isolated host with this plugin and a goal that stalls into a paused
// state, then holds it so a real TUI can attach (python3 spikes/tui-capture.py).
import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { goalHost, newSession, script, waitStatus } from "../test/host/goal.helpers"

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
