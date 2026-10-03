// Run state for one goal and the rules about who may change it. The worker
// model can report progress, claim, block, flag and wait; only the owner (or the
// host acting on owner policy) can start, resume, pause, abort or approve.
import type { Contract } from "../contract/types"

export type Status =
  | "running"
  | "waiting"
  | "verifying"
  | "paused"
  | "blocked"
  | "needs_review"
  | "budget_limited"
  | "complete"
  | "failed"
  | "aborted"
  | "superseded"

export const ACTIVE: readonly Status[] = ["running", "waiting", "verifying"]
export const TERMINAL: readonly Status[] = ["complete", "failed", "aborted", "superseded"]
export const isActive = (s: Status) => ACTIVE.includes(s)
export const isTerminal = (s: Status) => TERMINAL.includes(s)

export type CriterionState = {
  status: "unknown" | "pass" | "fail" | "claimed"
  by?: "host" | "verifier" | "verifier-fallback" | "human"
  at?: number
  detail?: string
  rejections: number
}

export type PendingKind = "kickoff" | "continue" | "verdict" | "recovery" | "wrapup" | "resume"

export type RunState = {
  version: 1
  slug: string
  title: string
  sessionID: string
  runId: string
  lock: string
  status: Status
  reason?: string
  createdAt: number
  updatedAt: number
  turn: number
  activeMs: number
  activeSince: number | null
  usage: { tokens: number; cost: number; baseTokens: number | null; baseCost: number | null }
  base: { commit?: string }
  fingerprint?: string
  counters: { noProgress: number; failures: number }
  wrapup: boolean
  blocker?: { key: string; count: number; reason: string; needs?: string; lastTurn: number }
  criteria: Record<string, CriterionState>
  steps: Record<string, "pending" | "active" | "done">
  progress?: { note: string; next?: string; at: number; turn: number }
  verdict?: { at: number; turn: number; passed: boolean; lines: string[] }
  claim?: { at: number; turn: number; summary: string; evidence: Record<string, string> }
  wait?: { until: number; reason: string }
  pending?: { messageID: string; turn: number; at: number; kind: PendingKind }
  turnFacts: { tools: number; goalCalls: number; stepsChanged: boolean }
  steers: number
  compacted: boolean
  /** last wall-clock ms the TUI/rpc was refreshed by a usage.recorded burst (T013) */
  lastUsageEmit?: number
  flags: Array<{ criterion?: string; kind: string; reason: string; at: number }>
  amendments: Array<{ change: string; rationale: string; at: number; status: "proposed" | "accepted" | "rejected" }>
}

export function initialRun(contract: Contract, args: { sessionID: string; runId: string; lock: string; commit?: string; now?: number }): RunState {
  const now = args.now ?? Date.now()
  return {
    version: 1,
    slug: contract.id,
    title: contract.title,
    sessionID: args.sessionID,
    runId: args.runId,
    lock: args.lock,
    status: "running",
    createdAt: now,
    updatedAt: now,
    turn: 0,
    activeMs: 0,
    activeSince: now,
    usage: { tokens: 0, cost: 0, baseTokens: null, baseCost: null },
    base: args.commit ? { commit: args.commit } : {},
    counters: { noProgress: 0, failures: 0 },
    wrapup: false,
    criteria: Object.fromEntries([...contract.criteria, ...contract.invariants].map((c) => [c.id, { status: "unknown", rejections: 0 } as CriterionState])),
    steps: Object.fromEntries(contract.plan.map((s, i) => [s.id, i === 0 ? "active" : "pending"])),
    turnFacts: { tools: 0, goalCalls: 0, stepsChanged: false },
    steers: 0,
    compacted: false,
    flags: [],
    amendments: [],
  }
}

/** Accumulate active (running/waiting/verifying) wall time. */
export function account(state: RunState, now = Date.now()): RunState {
  if (state.activeSince !== null) {
    state.activeMs += Math.max(0, now - state.activeSince)
    state.activeSince = isActive(state.status) ? now : null
  } else if (isActive(state.status)) state.activeSince = now
  state.updatedAt = now
  return state
}

/** Move to a new status, keeping the active clock honest. */
export function setStatus(state: RunState, status: Status, reason?: string, now = Date.now()): RunState {
  account(state, now)
  state.status = status
  state.reason = reason
  state.activeSince = isActive(status) ? now : null
  if (!isActive(status)) state.pending = undefined
  return state
}

export type OwnerAction = "pause" | "resume" | "abort" | "verify" | "approve" | "reject" | "amend" | "archive"

/** Owner transitions; returns an error string when the action does not apply. */
export function ownerCan(state: RunState, action: OwnerAction): string | undefined {
  switch (action) {
    case "pause":
      return isActive(state.status) ? undefined : `goal is ${state.status}`
    case "resume":
      return ["paused", "blocked", "needs_review", "budget_limited"].includes(state.status) ? undefined : `goal is ${state.status}; only a stopped goal can resume`
    case "abort":
      return isTerminal(state.status) ? `goal is already ${state.status}` : undefined
    case "verify":
      return isTerminal(state.status) ? `goal is ${state.status}` : undefined
    case "amend":
      // T038: amendment re-locks a live contract; a terminal goal gets a new
      // goal instead (supersession), never a rewrite of history.
      return isTerminal(state.status) ? `goal is ${state.status}; write a new goal or supersede it instead` : undefined
    case "archive":
      // T032: demote-never-delete applies to finished work; a live goal is
      // aborted first, never archived mid-flight.
      return isTerminal(state.status) ? undefined : `goal is ${state.status}; abort it before archiving`
    case "approve":
    case "reject":
      return isTerminal(state.status) ? `goal is ${state.status}` : undefined
  }
}

export type ModelAction = "progress" | "claim" | "block" | "flag" | "wait" | "amend"

/** The worker may only act on a goal that is running in its own session. */
export function modelCan(state: RunState | undefined, action: ModelAction): string | undefined {
  if (!state) return "no goal is running in this session"
  if (isTerminal(state.status)) return `the goal is ${state.status}`
  if (state.status === "verifying" && action !== "progress") return "the host is verifying your last claim; end your turn"
  if (!["running", "waiting", "verifying"].includes(state.status)) return `the goal is ${state.status}; the owner must resume it`
  return undefined
}

export const budgetUse = (state: RunState, contract: Contract, now = Date.now()) => {
  const active = state.activeMs + (state.activeSince !== null ? Math.max(0, now - state.activeSince) : 0)
  const b = contract.budget
  const parts: Array<{ name: "turns" | "wall" | "tokens" | "cost"; used: number; limit: number }> = []
  if (b.turns) parts.push({ name: "turns", used: state.turn, limit: b.turns })
  if (b.wallMs) parts.push({ name: "wall", used: active, limit: b.wallMs })
  if (b.tokens) parts.push({ name: "tokens", used: state.usage.tokens, limit: b.tokens })
  if (b.cost_usd) parts.push({ name: "cost", used: state.usage.cost, limit: b.cost_usd })
  const ratio = parts.reduce((max, p) => Math.max(max, p.used / p.limit), 0)
  return { active, parts, ratio }
}
