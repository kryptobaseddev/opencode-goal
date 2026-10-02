// Drives a real, isolated OpenCode 2 server against a scripted
// OpenAI-compatible provider. Nothing touches the owner's HOME, config,
// data or running sessions: every XDG directory points into a temp root.
import { OpenCode } from "@opencode/client"
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

export const OPENCODE_BINARY = process.env.OPENCODE_BINARY ?? join(homedir(), ".opencode", "bin", "opencode")
const PASSWORD = "local-test-only"

export type ToolCall = { name: string; args: Record<string, unknown> }
export type Reply = { text?: string; toolCalls?: ToolCall[]; delayMs?: number; usage?: { prompt: number; completion: number } }
export type ChatRequest = {
  model: string
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }>
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>
  [key: string]: unknown
}
export type Script = (request: ChatRequest, index: number) => Reply | Promise<Reply>

export type Fixture = { url: string; requests: ChatRequest[]; stop(): void }

/** A scripted chat-completions endpoint that streams one reply per request. */
export function startFixture(script: Script): Fixture {
  const requests: ChatRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await req.json()) as ChatRequest
      const index = requests.push(body) - 1
      const reply = await script(body, index)
      const id = `chat-${index}`
      const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder()
          if (reply.delayMs) await Bun.sleep(reply.delayMs)
          if (reply.text) controller.enqueue(enc.encode(chunk({ role: "assistant", content: reply.text }, null)))
          if (reply.toolCalls?.length) {
            const tool_calls = reply.toolCalls.map((call, i) => ({ index: i, id: `call-${index}-${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }))
            controller.enqueue(enc.encode(chunk({ role: "assistant", tool_calls }, null)))
          }
          const usage = { prompt_tokens: reply.usage?.prompt ?? 100, completion_tokens: reply.usage?.completion ?? 20, total_tokens: (reply.usage?.prompt ?? 100) + (reply.usage?.completion ?? 20) }
          controller.enqueue(enc.encode(chunk({}, reply.toolCalls?.length ? "tool_calls" : "stop", usage)))
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

export type HostOptions = {
  script: Script
  /** Absolute plugin directories (or {package, options}) to load. */
  plugins?: Array<string | { package: string; options?: Record<string, unknown> }>
  /** Files to create inside the project, relative path → content. */
  files?: Record<string, string>
  /** Extra opencode.json keys merged over the defaults. */
  config?: Record<string, unknown>
  /** Initialise the project as a git repository with one commit. */
  git?: boolean
}

export type Host = Awaited<ReturnType<typeof startHost>>

export async function startHost(options: HostOptions) {
  const root = await mkdtemp(join(tmpdir(), "ocgoal-host-"))
  const project = join(root, "project")
  for (const dir of [project, ...["home", "data", "config", "cache", "state"].map((d) => join(root, d))]) await mkdir(dir, { recursive: true })
  const fixture = startFixture(options.script)
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "fixture/test",
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Fixture",
        options: { baseURL: fixture.url, apiKey: "test-only" },
        models: { test: { name: "Fixture model" } },
      },
    },
    plugins: options.plugins ?? [],
    ...options.config,
  }
  await writeFile(join(project, "opencode.json"), JSON.stringify(config, null, 2))
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const file = join(project, rel)
    await mkdir(join(file, ".."), { recursive: true })
    await writeFile(file, content)
  }
  if (options.git) {
    const run = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: project, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
    run("init", "-q", "-b", "main")
    run("add", "-A")
    run("commit", "-q", "-m", "init")
  }

  const reserve = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = reserve.port
  reserve.stop(true)

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: join(root, "home"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  }
  delete env.BUN_BE_BUN
  const child = Bun.spawn([OPENCODE_BINARY, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  let log = ""
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) log += decoder.decode(chunk)
  }
  void drain(child.stdout)
  void drain(child.stderr)

  const location = { directory: project }
  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { "x-opencode-directory": project, authorization: "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64") },
  })

  let ready = false
  for (let i = 0; i < 200; i++) {
    try {
      await client.server.info()
      ready = true
      break
    } catch {}
    if (child.exitCode !== null) break
    await Bun.sleep(100)
  }
  if (!ready) {
    child.kill()
    fixture.stop()
    throw new Error(`opencode serve did not start:\n${log}`)
  }

  return {
    root,
    project,
    location,
    client,
    url: `http://127.0.0.1:${port}`,
    env,
    password: PASSWORD,
    fixture,
    log: () => log,
    async readProject(rel: string) {
      return readFile(join(project, rel), "utf8")
    },
    async stop(keep = !!process.env.KEEP_HOST) {
      child.kill("SIGTERM")
      await Promise.race([child.exited, Bun.sleep(5000)])
      fixture.stop()
      await writeFile(join(root, "server.log"), log).catch(() => {})
      if (!keep) await rm(root, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/** Polls until `check` returns a truthy value or the timeout elapses. */
export async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 30000, stepMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value as T
    } catch (error) {
      last = error
    }
    await Bun.sleep(stepMs)
  }
  throw new Error(`timed out after ${timeoutMs}ms${last ? `: ${last}` : ""}`)
}

/** The tool names the fixture saw on a request. */
export const toolNames = (request: ChatRequest) => (request.tools ?? []).map((t) => t.function.name)

/** The text of the last user/tool message in a request, for scripting replies. */
export const lastText = (request: ChatRequest) => {
  const last = request.messages.at(-1)
  return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "")
}
