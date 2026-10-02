// Starts an isolated host with the probe plugin and a session, then waits so a
// real TUI can attach. Writes connection details to .tmp/spikes/tui-host.json.
import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { startHost } from "../test/host/harness"

const host = await startHost({ plugins: [join(import.meta.dir, "probe")], git: true, script: () => ({ text: "fixture reply" }) })
const session: any = await host.client.session.create({ location: host.location, agent: "build", model: { providerID: "fixture", id: "test" } } as any)
await host.client.session.prompt({ sessionID: session.id, text: "hello from the TUI spike" } as any)
await host.client.session.wait({ sessionID: session.id })
const out = join(import.meta.dir, "..", ".tmp", "spikes")
await mkdir(out, { recursive: true })
await writeFile(join(out, "tui-host.json"), JSON.stringify({ url: host.url, sessionID: session.id, project: host.project, env: host.env, password: host.password }, null, 2))
console.log("READY", host.url, session.id)
await Bun.sleep(Number(process.env.HOLD_MS ?? 60000))
await host.stop()
