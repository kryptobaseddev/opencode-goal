// T027 — optional first-class CLEO linkage. When the project carries a CLEO
// workspace, the goal records the linkage THROUGH THE CLI ONLY (never by
// reading .cleo/*.db); the project-context.json config file may be read as a
// presence signal and fallback. No CLEO → the goal system behaves identically;
// there is no hard dependency either way.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type CleoFacts = { source: "cli" | "config"; projectId?: string; projectTypes: string[]; detectedAt?: string }

export type Runner = (command: string, args: string[], timeoutMs?: number) => Promise<{ stdout: string; exit: number }>

/**
 * Detect CLEO linkage for a project root. Order: the `cleo` CLI (authoritative,
 * spawn with a hard timeout), then .cleo/project-context.json (presence +
 * config facts), then none. All failures degrade to undefined — never throw.
 */
export async function cleoFacts(projectRoot: string, run: Runner, timeoutMs = 2500): Promise<CleoFacts | undefined> {
  const config = join(projectRoot, ".cleo", "project-context.json")
  const hasConfig = existsSync(config)
  if (!hasConfig && !existsSync(join(projectRoot, ".cleo"))) return undefined
  try {
    const { stdout, exit } = await run("cleo", ["doctor", "project-identity"], timeoutMs)
    if (exit === 0 && stdout.trim()) {
      const parsed = JSON.parse(stdout)
      const data = parsed?.data ?? parsed
      const projectId = typeof data?.projectId === "string" ? data.projectId : typeof parsed?.projectId === "string" ? parsed.projectId : undefined
      return { source: "cli", projectId, projectTypes: [] }
    }
  } catch {
    // CLI missing, too slow, or errored — degrade to the config signal
  }
  if (!hasConfig) return undefined
  try {
    const parsed = JSON.parse(readFileSync(config, "utf8"))
    return { source: "config", projectTypes: Array.isArray(parsed?.projectTypes) ? parsed.projectTypes.map(String) : [], ...(parsed?.detectedAt ? { detectedAt: String(parsed.detectedAt) } : {}) }
  } catch {
    return { source: "config", projectTypes: [] }
  }
}

/** The ledger payload recorded when a goal starts in a CLEO-linked project. */
export function cleoLinkEvent(facts: CleoFacts | undefined) {
  return facts ? { type: "cleo-linked" as const, via: facts.source, ...(facts.projectId ? { projectId: facts.projectId } : {}), ...(facts.projectTypes.length ? { projectTypes: facts.projectTypes } : {}) } : undefined
}
