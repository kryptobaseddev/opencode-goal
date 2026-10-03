import { join } from "node:path"
import { startHost, until, type ChatRequest, type Reply, type Script } from "./harness"

export const PLUGIN = join(import.meta.dir, "..", "..")

export const DEMO_GOAL = `schema: goal/v1
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
  - {id: S1, title: Write done.txt, proves: [C1, C2, C3]}
`

export const text = (m: ChatRequest["messages"][number] | undefined) =>
  !m ? "" : typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as any[]).map((p) => p?.text ?? "").join("") : JSON.stringify(m.content ?? "")

/** The last user message (the turn's trigger) and how many tool results follow it. */
export function turnOf(req: ChatRequest) {
  let lastUser = -1
  for (let i = req.messages.length - 1; i >= 0; i--)
    if (req.messages[i]!.role === "user") {
      lastUser = i
      break
    }
  const trigger = text(req.messages[lastUser])
  const results = req.messages.slice(lastUser + 1).filter((m) => m.role === "tool").length
  return { trigger, results, all: JSON.stringify(req.messages) }
}

export const isVerifier = (req: ChatRequest) => JSON.stringify(req.messages).includes("independent completion verifier")

/** Wraps a worker script: answers title requests and the verifier. */
export function script(worker: (req: ChatRequest, turn: ReturnType<typeof turnOf>) => Reply, verifier?: (req: ChatRequest) => Reply): Script {
  return (req) => {
    if (!req.tools?.length) return { text: "Goal session" }
    if (isVerifier(req)) {
      if (req.messages.at(-1)?.role === "tool") return { text: "Verdict recorded." }
      return verifier ? verifier(req) : { toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "not_proven", reason: "no verifier script" }] } }] }
    }
    return worker(req, turnOf(req))
  }
}

export async function goalHost(worker: Script, files: Record<string, string> = {}) {
  return startHost({
    plugins: [PLUGIN],
    git: true,
    files: { "README.md": "# demo\n", "oracle.txt": "do not edit\n", ".opencode/goals/demo/goal.yaml": DEMO_GOAL, ...files },
    script: worker,
  })
}

export async function newSession(host: Awaited<ReturnType<typeof goalHost>>) {
  const session: any = await host.client.session.create({ location: host.location, agent: "build", model: { providerID: "fixture", id: "test" } } as any)
  return session.id as string
}

export async function run(host: Awaited<ReturnType<typeof goalHost>>, slug = "demo") {
  return JSON.parse(await host.readProject(`.opencode/goals/${slug}/run.json`))
}

export async function ledger(host: Awaited<ReturnType<typeof goalHost>>, slug = "demo") {
  return (await host.readProject(`.opencode/goals/${slug}/ledger.jsonl`)).trim().split("\n").map((l) => JSON.parse(l))
}

export async function waitStatus(host: Awaited<ReturnType<typeof goalHost>>, statuses: string[], timeoutMs = 60000) {
  return until(async () => {
    const r = await run(host).catch(() => undefined)
    return r && statuses.includes(r.status) ? r : undefined
  }, timeoutMs, 200)
}
