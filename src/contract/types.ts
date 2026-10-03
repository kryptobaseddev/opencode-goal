// goal/v1: the contract a goal is executed against. Written by the owner (usually
// through the write-goal skill), locked by hash when a run starts, never edited by
// the worker agent.

export const SCHEMA = "goal/v1" as const

export type Expect = {
  exit?: number
  stdout_contains?: string
  stdout_regex?: string
}

export type CommandCheck = { kind: "command"; run: string; expect?: Expect; timeout?: number; runs?: number; live?: boolean }
export type FileCheck = { kind: "file"; path: string; exists?: boolean }
export type ContainsCheck = { kind: "contains"; path: string; text?: string; regex?: string }
export type AbsentCheck = { kind: "absent"; pattern: string; paths?: string[] }
export type DiffCheck = { kind: "diff"; paths: string[] }
export type VerifierCheck = { kind: "verifier"; ask: string }
export type HumanCheck = { kind: "human"; ask: string }

export type Check = CommandCheck | FileCheck | ContainsCheck | AbsentCheck | DiffCheck | VerifierCheck | HumanCheck
export type CheckKind = Check["kind"]

export const HOST_KINDS = ["command", "file", "contains", "absent", "diff"] as const
export const CHECK_KINDS = [...HOST_KINDS, "verifier", "human"] as const
export const isHostCheck = (check: Check): boolean => (HOST_KINDS as readonly string[]).includes(check.kind)

export type Criterion = {
  id: string
  statement: string
  essential: boolean
  check: Check
}

export type Assumption = {
  id: string
  text: string
  rationale?: string
  reversible?: boolean
  status: "assumed" | "confirmed" | "vetoed"
}

export type Step = {
  id: string
  title: string
  proves: string[]
  depends_on: string[]
}

export type Budget = {
  turns?: number
  /** Wall-clock budget in milliseconds of active run time. */
  wallMs?: number
  /** Token spend (input + output + reasoning) across the run. */
  tokens?: number
  cost_usd?: number
}

export type Autonomy = {
  questions: "defer" | "allow"
  on_user_message: "steer" | "pause"
  on_interrupt: "pause" | "resume-on-message"
}

export type VerificationMode = "host" | "host+verifier" | "strict"

export type Contract = {
  schema: typeof SCHEMA
  id: string
  title: string
  /** T031: "<slug>@<lock-prefix>" — this goal replaces that one (owner-approved append, never a rewrite). */
  supersedes?: string
  intent: { verbatim: string }
  outcome: string
  why?: string
  scope: { in: string[]; out: string[] }
  non_goals: string[]
  constraints: string[]
  criteria: Criterion[]
  invariants: Criterion[]
  protect: string[]
  assumptions: Assumption[]
  plan: Step[]
  budget: Budget
  stop: { when?: string; escalate_when: string[] }
  autonomy: Autonomy
  verification: { mode: VerificationMode; max_rejections: number }
  execution: { agent?: string }
  meta: Record<string, unknown>
}

export type Issue = { level: "error" | "warning"; path: string; message: string }
