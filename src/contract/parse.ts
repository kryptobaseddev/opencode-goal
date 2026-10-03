// Parses and validates goal.yaml. Every rule here is one the write-goal skill
// relies on to tell a loop-verifiable goal from a wish.
import { createHash } from "node:crypto"
import {
  CHECK_KINDS,
  HOST_KINDS,
  SCHEMA,
  type Assumption,
  type Autonomy,
  type Budget,
  type Check,
  type Contract,
  type Criterion,
  type Issue,
  type Step,
  type VerificationMode,
} from "./types"

export type ParseResult = { contract?: Contract; issues: Issue[]; lock: string }

const VAGUE = [
  "fast",
  "faster",
  "quick",
  "quickly",
  "robust",
  "clean",
  "cleaner",
  "better",
  "properly",
  "proper",
  "nice",
  "good",
  "efficient",
  "scalable",
  "intuitive",
  "user-friendly",
  "seamless",
  "seamlessly",
  "optimal",
  "optimized",
  "improved",
  "reasonable",
  "appropriate",
  "correctly",
  "works",
]
const ACTIVITY = /^(keep|continue|improve|investigate|explore|work on|look into|try to|help|refactor as needed|clean up)\b/i

export const lockOf = (text: string) => createHash("sha256").update(text).digest("hex")

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "")
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : [])

/** "90m", "3h", "1h30m", "45s", "2d" → ms. A bare number means minutes. */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 ? value * 60_000 : undefined
  const text = str(value).toLowerCase().replace(/\s+/g, "")
  if (!text) return undefined
  const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }
  let total = 0
  let matched = ""
  for (const part of text.matchAll(/(\d+(?:\.\d+)?)([dhms])/g)) {
    total += Number(part[1]) * units[part[2]!]!
    matched += part[0]
  }
  return matched === text && total > 0 ? Math.round(total) : undefined
}

/** "3M", "400k", "1.5m", 250000 → tokens. */
export function parseCount(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 ? Math.round(value) : undefined
  const match = /^(\d+(?:\.\d+)?)\s*([kmb])?$/i.exec(str(value))
  if (!match) return undefined
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[(match[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1
  const n = Math.round(Number(match[1]) * scale)
  return n > 0 ? n : undefined
}

function vagueWords(text: string): string[] {
  if (/\d/.test(text)) return []
  const lower = ` ${text.toLowerCase()} `
  return VAGUE.filter((word) => new RegExp(`[^a-z-]${word.replace("-", "\\-")}[^a-z-]`).test(lower))
}

function parseCheck(raw: unknown, path: string, issues: Issue[]): Check | undefined {
  if (!isRecord(raw)) {
    issues.push({ level: "error", path, message: "check is required: say how this criterion is proven (a command, a file test, a search, or a verifier question)" })
    return undefined
  }
  const kind = str(raw.kind)
  if (!(CHECK_KINDS as readonly string[]).includes(kind)) {
    issues.push({ level: "error", path: `${path}.kind`, message: `unknown check kind "${kind}"; use one of ${CHECK_KINDS.join(", ")}` })
    return undefined
  }
  const need = (field: string, value: string) => {
    if (!value) issues.push({ level: "error", path: `${path}.${field}`, message: `${kind} check needs ${field}` })
    return value
  }
  switch (kind) {
    case "command": {
      const expect = isRecord(raw.expect) ? raw.expect : {}
      const out: Check = {
        kind,
        run: need("run", str(raw.run)),
        expect: {
          ...(expect.exit !== undefined ? { exit: Number(expect.exit) } : {}),
          ...(str(expect.stdout_contains) ? { stdout_contains: str(expect.stdout_contains) } : {}),
          ...(str(expect.stdout_regex) ? { stdout_regex: str(expect.stdout_regex) } : {}),
        },
        ...(raw.timeout !== undefined ? { timeout: Number(raw.timeout) } : {}),
        ...(raw.runs !== undefined ? { runs: Math.max(1, Math.min(10, Number(raw.runs) || 1)) } : {}),
        ...(raw.live === true ? { live: true } : {}),
      }
      // T021: a newline in a command check is usually a YAML folded-scalar
      // accident (>- keeps literal newlines before more-indented lines), which
      // made run 0ffe5ac6e001 C3 unrunnable — the host shell executed the
      // skill directory as a command. Intentional multi-line shell is legal,
      // so warn, and always rehearse the exact stored command before claiming.
      if (typeof out.run === "string" && out.run.includes("\n"))
        issues.push({ level: "warning", path: `${path}.run`, message: "command check spans lines: YAML folded scalars (>-) keep literal newlines before more-indented lines, and the host shell will execute each line separately — keep the command on one line unless the newlines are intentional, and rehearse the stored command before claiming" })
      if (out.expect && out.expect.exit === undefined && !out.expect.stdout_contains && !out.expect.stdout_regex) out.expect.exit = 0
      if (out.expect?.stdout_regex) {
        try {
          new RegExp(out.expect.stdout_regex)
        } catch {
          issues.push({ level: "error", path: `${path}.expect.stdout_regex`, message: "not a valid regular expression" })
        }
      }
      if (out.timeout !== undefined && !(out.timeout > 0)) issues.push({ level: "error", path: `${path}.timeout`, message: "timeout must be a positive number of seconds" })
      return out
    }
    case "file":
      return { kind, path: need("path", str(raw.path)), exists: raw.exists !== false }
    case "contains": {
      const text = str(raw.text)
      const regex = str(raw.regex)
      if (!text && !regex) issues.push({ level: "error", path, message: "contains check needs text or regex" })
      return { kind, path: need("path", str(raw.path)), ...(text ? { text } : {}), ...(regex ? { regex } : {}) }
    }
    case "absent":
      return { kind, pattern: need("pattern", str(raw.pattern)), ...(strings(raw.paths).length ? { paths: strings(raw.paths) } : {}) }
    case "diff": {
      const paths = strings(raw.paths)
      if (!paths.length) issues.push({ level: "error", path: `${path}.paths`, message: "diff check needs at least one path" })
      return { kind, paths }
    }
    default:
      return { kind: kind as "verifier" | "human", ask: need("ask", str(raw.ask)) }
  }
}

function parseCriteria(raw: unknown, path: string, prefix: "C" | "I", issues: Issue[]): Criterion[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item, index) => {
    const at = `${path}[${index}]`
    if (!isRecord(item)) {
      issues.push({ level: "error", path: at, message: "must be a mapping with id, statement and check" })
      return []
    }
    const id = str(item.id)
    if (!new RegExp(`^${prefix}\\d+$`).test(id)) issues.push({ level: "error", path: `${at}.id`, message: `id must look like ${prefix}1, ${prefix}2, …` })
    const statement = str(item.statement)
    if (!statement) issues.push({ level: "error", path: `${at}.statement`, message: "statement is required" })
    const vague = vagueWords(statement)
    if (vague.length) issues.push({ level: "warning", path: `${at}.statement`, message: `vague without a number: ${vague.join(", ")} — state the threshold that proves it` })
    const check = parseCheck(item.check, `${at}.check`, issues)
    if (prefix === "I" && check && !(HOST_KINDS as readonly string[]).includes(check.kind))
      issues.push({ level: "error", path: `${at}.check.kind`, message: "invariants must be host-checkable (command, file, contains, absent or diff)" })
    if (!check) return []
    return [{ id, statement, essential: prefix === "I" ? true : item.essential !== false, check }]
  })
}

export function parseContract(text: string, options: { slug?: string } = {}): ParseResult {
  const issues: Issue[] = []
  const lock = lockOf(text)
  let raw: unknown
  try {
    raw = (Bun as any).YAML.parse(text)
  } catch (error) {
    issues.push({ level: "error", path: "", message: `not valid YAML: ${error instanceof Error ? error.message : String(error)}${yamlHint(text)}` })
    return { issues, lock }
  }
  if (!isRecord(raw)) {
    issues.push({ level: "error", path: "", message: "goal.yaml must be a mapping" })
    return { issues, lock }
  }

  const err = (path: string, message: string) => issues.push({ level: "error", path, message })
  const warn = (path: string, message: string) => issues.push({ level: "warning", path, message })

  if (raw.schema !== SCHEMA) err("schema", `schema must be "${SCHEMA}"`)
  const id = str(raw.id)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) err("id", "id must be a kebab-case slug (a-z, 0-9, hyphens)")
  else if (options.slug && id !== options.slug) err("id", `id "${id}" must match its directory name "${options.slug}"`)
  const title = str(raw.title)
  if (!title) err("title", "title is required")
  else if (title.length > 80) warn("title", "keep the title under 80 characters; it is shown in the sidebar")

  const intent = isRecord(raw.intent) ? str(raw.intent.verbatim) : str(raw.intent)
  if (!intent) err("intent.verbatim", "record the owner's own words verbatim; they stay the authoritative source")

  const outcome = str(raw.outcome)
  if (!outcome) err("outcome", "outcome is required: one end state that will be true when the goal is done")
  else {
    if (ACTIVITY.test(outcome)) warn("outcome", "reads as an activity; state the end state that becomes true instead")
    const vague = vagueWords(outcome)
    if (vague.length) warn("outcome", `vague without a number: ${vague.join(", ")}`)
  }

  const nonGoals = strings(raw.non_goals)
  if (!nonGoals.length) err("non_goals", "list at least one non-goal so the loop does not fill the vacuum")

  const criteria = parseCriteria(raw.criteria, "criteria", "C", issues)
  if (!Array.isArray(raw.criteria) || !raw.criteria.length) err("criteria", "at least one criterion is required")
  else if (!criteria.some((c) => c.essential)) err("criteria", "at least one criterion must be essential")
  else if (!criteria.some((c) => c.essential && (HOST_KINDS as readonly string[]).includes(c.check.kind)))
    warn("criteria", "no essential criterion is host-checkable; completion will rest on the verifier and the owner")
  const invariants = parseCriteria(raw.invariants, "invariants", "I", issues)

  const ids = new Set<string>()
  for (const item of [...criteria, ...invariants]) {
    if (ids.has(item.id)) err(item.id, `duplicate id ${item.id}`)
    ids.add(item.id)
  }

  const assumptions: Assumption[] = (Array.isArray(raw.assumptions) ? raw.assumptions : []).flatMap((item: unknown, index: number) => {
    if (!isRecord(item)) return []
    const aid = str(item.id) || `A${index + 1}`
    if (!/^A\d+$/.test(aid)) err(`assumptions[${index}].id`, "id must look like A1, A2, …")
    const status = str(item.status) || "assumed"
    if (!["assumed", "confirmed", "vetoed"].includes(status)) err(`assumptions[${index}].status`, "status must be assumed, confirmed or vetoed")
    return [{ id: aid, text: str(item.text), ...(str(item.rationale) ? { rationale: str(item.rationale) } : {}), ...(typeof item.reversible === "boolean" ? { reversible: item.reversible } : {}), status: status as Assumption["status"] }]
  })

  const plan: Step[] = (Array.isArray(raw.plan) ? raw.plan : []).flatMap((item: unknown, index: number) => {
    if (!isRecord(item)) return []
    const sid = str(item.id)
    if (!/^S\d+$/.test(sid)) err(`plan[${index}].id`, "id must look like S1, S2, …")
    return [{ id: sid, title: str(item.title), proves: strings(item.proves), depends_on: strings(item.depends_on) }]
  })
  const stepIds = new Set(plan.map((s) => s.id))
  for (const step of plan) {
    for (const ref of step.proves) if (!criteria.some((c) => c.id === ref)) err(`plan.${step.id}.proves`, `unknown criterion ${ref}`)
    for (const ref of step.depends_on) if (!stepIds.has(ref)) err(`plan.${step.id}.depends_on`, `unknown step ${ref}`)
    if (!step.title) err(`plan.${step.id}.title`, "step title is required")
  }
  if (hasCycle(plan)) err("plan", "step dependencies form a cycle")

  const budgetRaw = isRecord(raw.budget) ? raw.budget : {}
  const budget: Budget = {}
  if (budgetRaw.turns !== undefined) {
    const turns = Number(budgetRaw.turns)
    if (Number.isInteger(turns) && turns > 0) budget.turns = turns
    else err("budget.turns", "turns must be a positive integer")
  }
  if (budgetRaw.wall !== undefined) {
    const wallMs = parseDuration(budgetRaw.wall)
    if (wallMs) budget.wallMs = wallMs
    else err("budget.wall", 'wall must be a duration such as "90m" or "3h"')
  }
  if (budgetRaw.tokens !== undefined) {
    const tokens = parseCount(budgetRaw.tokens)
    if (tokens) budget.tokens = tokens
    else err("budget.tokens", 'tokens must be a count such as 400k or "3M"')
  }
  if (budgetRaw.cost_usd !== undefined) {
    const cost = Number(budgetRaw.cost_usd)
    if (cost > 0) budget.cost_usd = cost
    else err("budget.cost_usd", "cost_usd must be a positive number")
  }

  const autonomyRaw = isRecord(raw.autonomy) ? raw.autonomy : {}
  const pick = <T extends string>(path: string, value: unknown, allowed: readonly T[], fallback: T): T => {
    const v = str(value)
    if (!v) return fallback
    if ((allowed as readonly string[]).includes(v)) return v as T
    err(path, `must be one of ${allowed.join(", ")}`)
    return fallback
  }
  const autonomy: Autonomy = {
    questions: pick("autonomy.questions", autonomyRaw.questions, ["defer", "allow"] as const, "defer"),
    on_user_message: pick("autonomy.on_user_message", autonomyRaw.on_user_message, ["steer", "pause"] as const, "steer"),
    on_interrupt: pick("autonomy.on_interrupt", autonomyRaw.on_interrupt, ["pause", "resume-on-message"] as const, "pause"),
  }
  const verificationRaw = isRecord(raw.verification) ? raw.verification : {}
  const mode = pick<VerificationMode>("verification.mode", verificationRaw.mode, ["host", "host+verifier", "strict"] as const, "host+verifier")
  const maxRejections = verificationRaw.max_rejections === undefined ? 3 : Number(verificationRaw.max_rejections)
  if (!(Number.isInteger(maxRejections) && maxRejections >= 1 && maxRejections <= 10)) err("verification.max_rejections", "max_rejections must be an integer from 1 to 10")

  const scopeRaw = isRecord(raw.scope) ? raw.scope : {}
  const stopRaw = isRecord(raw.stop) ? raw.stop : {}
  const executionRaw = isRecord(raw.execution) ? raw.execution : {}

  if (issues.some((i) => i.level === "error")) return { issues, lock }
  // T031: supersession pointer — "<slug>@<lock-prefix>", validated but only
  // enforced at /goal start (existence, lock match, mid-flight admission).
  const supersedes = str(raw.supersedes)
  if (supersedes && !/^[a-z0-9][a-z0-9-]{0,63}@[0-9a-f]{8,64}$/.test(supersedes))
    err("supersedes", "must look like \"<slug>@<lock-prefix>\" (the predecessor slug and the first bytes of its run lock)")

  const contract: Contract = {
    schema: SCHEMA,
    id,
    title,
    ...(supersedes ? { supersedes } : {}),
    intent: { verbatim: intent },
    outcome,
    ...(str(raw.why) ? { why: str(raw.why) } : {}),
    scope: { in: strings(scopeRaw.in), out: strings(scopeRaw.out) },
    non_goals: nonGoals,
    constraints: strings(raw.constraints),
    criteria,
    invariants,
    protect: strings(raw.protect),
    assumptions,
    plan,
    budget,
    stop: { ...(str(stopRaw.when) ? { when: str(stopRaw.when) } : {}), escalate_when: strings(stopRaw.escalate_when) },
    autonomy,
    verification: { mode, max_rejections: maxRejections },
    execution: str(executionRaw.agent) ? { agent: str(executionRaw.agent) } : {},
    meta: isRecord(raw.meta) ? raw.meta : {},
  }
  return { contract, issues, lock }
}

function hasCycle(plan: Step[]): boolean {
  const deps = new Map(plan.map((s) => [s.id, s.depends_on]))
  const state = new Map<string, 1 | 2>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false
    if (state.get(id) === 1) return true
    state.set(id, 1)
    for (const next of deps.get(id) ?? []) if (deps.has(next) && visit(next)) return true
    state.set(id, 2)
    return false
  }
  return plan.some((s) => visit(s.id))
}

/** Bun's YAML errors carry no position; point at the likeliest culprit. */
function yamlHint(text: string): string {
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const value = /^\s*(?:- )?[A-Za-z_][\w-]*:\s+([^'"\[{|>#].*)$/.exec(lines[i]!)?.[1]
    if (value && /:\s/.test(value)) return ` (line ${i + 1} has an unquoted value containing ": " — wrap the value in single quotes)`
  }
  return ""
}

export const formatIssues = (issues: Issue[]) =>
  issues.length ? issues.map((i) => `${i.level === "error" ? "✗" : "!"} ${i.path || "goal.yaml"}: ${i.message}`).join("\n") : "✓ goal.yaml is valid"
