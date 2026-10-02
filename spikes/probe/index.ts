// Spike probe: logs what OpenCode 2 actually does so the design can be checked
// against the running host. Plain-object export + type-only imports, so the
// probe does not depend on @opencode/plugin being resolvable at runtime.
import type { Plugin } from "@opencode/plugin"
type Context = Plugin.Context
import { appendFileSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { ProbeRpc } from "./rpc"

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16)
const clip = (value: unknown, max = 600) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text && text.length > max ? `${text.slice(0, max)}…(${text.length})` : text
}

export default {
  id: "probe",
  async setup(ctx: Context) {
    const dir = ctx.location.directory
    mkdirSync(join(dir, ".probe"), { recursive: true })
    const file = join(dir, ".probe", "log.jsonl")
    const log = (kind: string, data: unknown) => appendFileSync(file, JSON.stringify({ t: Date.now(), kind, data }) + "\n")

    log("setup", {
      location: ctx.location,
      options: ctx.options,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, SHELL: process.env.SHELL, HOME: process.env.HOME },
      bun: typeof Bun !== "undefined" ? Bun.version : null,
      contextKeys: Object.keys(ctx),
      sessionKeys: Object.keys(ctx.session),
    })

    // S9: YAML parser available in the plugin runtime?
    try {
      log("S9.yaml", (Bun as any).YAML.parse("a: 1\nlist: [x, y]\nnested:\n  k: v\n"))
    } catch (error) {
      log("S9.yaml-error", String(error))
    }

    // S4: environment of a login shell spawned by the plugin.
    const shell = process.env.SHELL || "/bin/sh"
    const probe = Bun.spawnSync([shell, "-lc", "echo PATH=$PATH; command -v node; command -v bun; command -v npm; command -v git"], { cwd: dir })
    log("S4.shell", { shell, exit: probe.exitCode, stdout: probe.stdout.toString(), stderr: clip(probe.stderr.toString()) })

    // S1/S5/S8: raw event stream (deltas skipped).
    const controller = new AbortController()
    ;(async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal }) as AsyncIterable<any>) {
          if (/delta|streamed|\.input\./.test(event.type)) continue
          log("event", { type: event.type, location: event.location, data: clip(event.data, 900) })
        }
      } catch (error) {
        log("event-loop-error", String(error))
      }
    })()

    // S3/S7: what each request carries; append a stable system block.
    await ctx.session.hook("context", (event) => {
      const system = JSON.stringify(event.system)
      log("S3.context", {
        sessionID: event.sessionID,
        agent: event.agent,
        systemHash: hash(system),
        systemLen: system.length,
        systemParts: event.system.length,
        messages: event.messages.length,
        lastRoles: event.messages.slice(-3).map((m: any) => m.role),
        tools: Object.keys(event.tools),
      })
      event.system.push({ type: "text", text: "PROBE-STABLE-BLOCK: goal contract would render here." })
    })

    await ctx.session.hook("compaction", (event) => {
      log("compaction-hook", { sessionID: event.sessionID, systemParts: event.system.length })
    })

    await ctx.session.hook("prompt", (event) => {
      log("prompt-hook", { sessionID: event.sessionID, messageID: event.messageID, delivery: event.delivery, metadata: event.metadata, prompt: clip(event.prompt) })
    })

    // S7: a hidden verifier agent and a tool only it should use.
    await ctx.agent.transform((editor) => {
      editor.update("probe-verifier", (agent: any) => {
        agent.name = "Probe verifier"
        agent.description = "Probe read-only verifier"
        agent.mode = "subagent"
        agent.hidden = true
        agent.permissions.push(
          { action: "*", resource: "*", effect: "deny" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "glob", resource: "*", effect: "allow" },
          { action: "grep", resource: "*", effect: "allow" },
          { action: "probe_verdict", resource: "*", effect: "allow" },
        )
      })
      for (const agent of editor.list()) {
        if (String(agent.id) === "probe-verifier") continue
        editor.update(String(agent.id), (item: any) => item.permissions.push({ action: "probe_verdict", resource: "*", effect: "deny" }))
      }
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "echo",
        description: "Probe tool: echoes its input.",
        options: { namespace: "probe", codemode: false },
        input: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        execute: async (input: any, context: any) => {
          log("tool.echo", { input, sessionID: context.sessionID, agent: context.agent, messageID: context.messageID })
          return { content: `echo: ${input.text}`, metadata: { echoed: input.text } }
        },
      } as any)
      editor.add({
        name: "verdict",
        description: "Probe tool reserved for the probe-verifier agent.",
        options: { namespace: "probe", codemode: false, permission: "probe_verdict" },
        input: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
        execute: async (input: any, context: any) => {
          log("tool.verdict", { input, agent: context.agent })
          return { content: context.agent === "probe-verifier" ? "accepted" : "refused: wrong agent" }
        },
      } as any)
    })

    // S2: prompt admission with a fixed id and metadata, twice.
    await ctx.command.transform((editor) => {
      editor.add({
        name: "probe-prompt",
        description: "Probe: admit the same prompt id twice.",
        execute: async ({ sessionID, prompt, delivery }) => {
          log("command", { sessionID, prompt: clip(prompt), delivery })
          const id = (prompt as any)?.text?.trim() || "msg_probe_fixed"
          for (const attempt of [1, 2]) {
            try {
              const result = await ctx.session.prompt({ sessionID, id, text: `probe continuation attempt ${attempt}`, metadata: { goal: { id: "G1", turn: 1 } }, resume: true } as any)
              log("S2.prompt", { attempt, result: clip(result) })
            } catch (error) {
              log("S2.prompt-error", { attempt, error: clip(String(error)) })
            }
          }
        },
      })
      editor.add({
        name: "probe-child",
        description: "Probe: create, prompt and remove a child session with the hidden agent.",
        execute: async ({ sessionID }) => {
          try {
            const child: any = await ctx.session.create({ parentID: sessionID, agent: "probe-verifier", title: "probe child" } as any)
            log("S7.child-created", clip(child))
            const childID = child?.id ?? child?.data?.id
            await ctx.session.prompt({ sessionID: childID, text: "VERIFY: call probe_verdict", resume: true } as any)
            await ctx.session.wait({ sessionID: childID } as any)
            log("S7.child-done", { childID })
            await ctx.session.remove({ sessionID: childID } as any)
            log("S7.child-removed", { childID })
          } catch (error) {
            log("S7.child-error", clip(String(error)))
          }
        },
      })
    })

    // S6: RPC methods + live events for the TUI.
    try {
      const registration: any = await (ctx.rpc as any).register(ProbeRpc, {
        ping: async (input: any) => ({ text: `pong for ${String(input.sessionID).slice(0, 12)}` }),
      })
      let n = 0
      const timer = setInterval(() => registration.events.emit("tick", { n: ++n }).catch(() => {}), 1000)
      controller.signal.addEventListener("abort", () => clearInterval(timer))
      log("S6.rpc-registered", {})
    } catch (error) {
      log("S6.rpc-error", String(error))
    }

    log("setup-done", {})
    return () => {
      controller.abort()
      log("cleanup", {})
    }
  },
}
