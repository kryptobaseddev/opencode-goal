// Runs the probe plugin inside an isolated OpenCode 2 server and prints what
// it observed. Usage: bun spikes/run.ts
import { join } from "node:path"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { startHost, until, toolNames, lastText, type ChatRequest } from "../test/host/harness"

const probeDir = join(import.meta.dir, "probe")
const asText = (r: ChatRequest) => JSON.stringify(r.messages)
const hasToolResult = (r: ChatRequest) => r.messages.at(-1)?.role === "tool"

const host = await startHost({
  plugins: [probeDir],
  git: true,
  files: { "README.md": "# probe project\n" },
  script: (req) => {
    const text = lastText(req)
    const all = asText(req)
    if (hasToolResult(req)) return { text: "tool step finished" }
    if (all.includes("VERIFY: call probe_verdict")) return { toolCalls: [{ name: "probe_verdict", args: { ok: true } }] }
    if (text.includes("ECHO")) return { toolCalls: [{ name: "probe_echo", args: { text: "hi" } }] }
    if (text.includes("FORBIDDEN")) return { toolCalls: [{ name: "probe_verdict", args: { ok: true } }] }
    if (text.includes("ASK")) return { toolCalls: [{ name: "question", args: { questions: [{ question: "Start the goal now?", header: "Launch", options: [{ label: "Start goal now", description: "Run it" }, { label: "Save for later", description: "Keep draft" }] }] } }] }
    if (text.includes("SLOW")) return { text: "slow reply", delayMs: 8000 }
    return { text: `fixture reply to: ${text.slice(0, 60)}` }
  },
})

const results: Record<string, unknown> = {}
const logFile = join(host.project, ".probe", "log.jsonl")
const entries = async () => (await readFile(logFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
const sid = (s: any) => s?.id ?? s?.data?.id

try {
  const { client, location } = host
  results.plugins = await client.plugin.list({ location } as any).catch((e: unknown) => String(e))
  await until(async () => (await entries()).some((e) => e.kind === "setup-done"), 30000)

  // Basic turn: tool visibility, execution events, context hook.
  const s1: any = await client.session.create({ location, agent: "build", model: { providerID: "fixture", id: "test" } } as any)
  const id1 = sid(s1)
  results.session1 = id1
  await client.session.prompt({ sessionID: id1, text: "please ECHO something" } as any)
  await client.session.wait({ sessionID: id1 })
  results.toolsSeenByModel = host.fixture.requests.map(toolNames)

  // Worker attempting the reserved tool.
  await client.session.prompt({ sessionID: id1, text: "FORBIDDEN tool attempt" } as any)
  await client.session.wait({ sessionID: id1 })

  // S2: same prompt id admitted twice from a plugin command.
  await client.session.command({ sessionID: id1, name: "probe-prompt", text: "msg_probe_fixed_1" } as any)
  await client.session.wait({ sessionID: id1 })
  await Bun.sleep(1500)
  await client.session.wait({ sessionID: id1 })
  const log1: any[] = []
  for await (const item of client.session.log({ sessionID: id1 } as any) as AsyncIterable<any>) log1.push(item)
  results.sessionLogTypes = log1.map((i) => i?.type ?? i?.data?.type ?? Object.keys(i ?? {}).join(","))
  results.sessionLogSample = JSON.stringify(log1.slice(-6)).slice(0, 4000)

  // S5: question form, reply.
  await client.session.prompt({ sessionID: id1, text: "ASK the owner" } as any)
  const form: any = await until(async () => {
    const forms: any = await client.session.form.list({ sessionID: id1 } as any)
    const list = Array.isArray(forms) ? forms : forms?.data
    return list?.[0]
  }, 20000)
  results.formInfo = form
  const formID = form.id
  const detail: any = await client.session.form.get({ sessionID: id1, formID } as any).catch((e: unknown) => String(e))
  results.formDetail = detail
  await client.session.form.reply({ sessionID: id1, formID, answer: { q0: "Start goal now" } } as any)
  await client.session.wait({ sessionID: id1 })

  // S8a: user interrupt during a slow reply.
  await client.session.prompt({ sessionID: id1, text: "SLOW reply please" } as any)
  await Bun.sleep(1500)
  results.interrupt = await client.session.interrupt({ sessionID: id1 } as any).catch((e: unknown) => String(e))
  await client.session.wait({ sessionID: id1 })

  // S8b: dismissed question.
  await client.session.prompt({ sessionID: id1, text: "ASK again" } as any)
  const form2: any = await until(async () => {
    const forms: any = await client.session.form.list({ sessionID: id1 } as any)
    const list = Array.isArray(forms) ? forms : forms?.data
    return list?.find((f: any) => f.id !== formID)
  }, 20000)
  await client.session.form.cancel({ sessionID: id1, formID: form2.id } as any)
  await client.session.wait({ sessionID: id1 })

  // S7: hidden verifier child session.
  await client.session.command({ sessionID: id1, name: "probe-child", text: "" } as any)
  await until(async () => (await entries()).some((e) => e.kind.startsWith("S7.child-removed") || e.kind === "S7.child-error"), 30000)

  // S1: a second project on the same server.
  const other = join(host.root, "other")
  await mkdir(other, { recursive: true })
  await writeFile(join(other, "opencode.json"), JSON.stringify({ model: "fixture/test", provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: host.fixture.url, apiKey: "x" }, models: { test: { name: "Fixture" } } } } }))
  const s2: any = await client.session.create({ location: { directory: other }, agent: "build", model: { providerID: "fixture", id: "test" } } as any)
  await client.session.prompt({ sessionID: sid(s2), text: "other project hello" } as any)
  await client.session.wait({ sessionID: sid(s2) })
  results.otherSession = sid(s2)
  results.otherProject = other
} catch (error) {
  results.error = String(error instanceof Error ? error.stack : error)
} finally {
  const log = await entries()
  results.probe = log
  const out = join(import.meta.dir, "..", ".tmp", "spikes")
  await mkdir(out, { recursive: true })
  await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2))
  await writeFile(join(out, "server.log"), host.log())
  await writeFile(join(out, "requests.json"), JSON.stringify(host.fixture.requests, null, 2))
  console.log(`wrote ${out}; probe entries: ${log.length}; error: ${results.error ?? "none"}`)
  await host.stop()
}
