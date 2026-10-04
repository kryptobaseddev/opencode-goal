// T045 — the post-goal summary. One pure builder turning what the run
// already has (contract, run state, ledger) into a summary the owner and the
// agent both see on terminal transitions: per-criterion outcomes WITH
// provenance — owner-approved and fallback-passed criteria carry explicit
// caveats, never silently equal to host-proven — the scope audit flags
// (T046), restated non-goals, mid-run findings from the ledger, and
// follow-up prompts including the CLEO-install suggestion when the project
// has no .cleo workspace. Rendered by the TUI dialog, a one-line
// goal.summary notice and a persisted evidence file.
import type { Contract } from "../contract/types"
import type { RunState } from "../engine/state"

export type Provenance = "host" | "verifier" | "verifier-fallback" | "human"

export type SummaryCriterion = {
  id: string
  statement: string
  status: "pass" | "fail" | "unknown"
  by?: Provenance
  detail?: string
  caveat?: string
}

export type ScopeAuditFlag = {
  /** what was discussed but left unproven: a plan step or a scope.in item */
  kind: "step" | "scope"
  id: string
  title: string
  why: string
}

export type SummaryFinding = { kind: string; text: string; at?: number }

export type PostGoalSummary = {
  slug: string
  title: string
  status: string
  turns: number
  headline: string
  criteria: SummaryCriterion[]
  caveats: string[]
  scopeAudit: ScopeAuditFlag[]
  nonGoals: string[]
  findings: SummaryFinding[]
  followUps: string[]
  text: string
}

/** The caveat a provenance carries. Owner approvals and fenced-json
 *  fallbacks are real evidence but weaker than host/verifier proof — the
 *  summary says so instead of laundering them as equivalent. */
export function provenanceCaveat(by: Provenance | undefined): string | undefined {
  if (by === "human") return "approved by the owner — final; not independently re-checked"
  if (by === "verifier-fallback") return "parsed from the verifier's prose fallback (fenced json, not a tool call); quotes were re-read by the host"
  return undefined
}

const label = (status: string) => (status === "pass" ? "✓ pass" : status === "fail" ? "✗ fail" : "· unknown")

/** Mid-run findings worth surfacing at the end, from the run's ledger:
 *  criterion flags, blocker keys, empty verifier rounds, fallback parses,
 *  amendments and budget stops. Unknown types are ignored. */
export function findingsFromLedger(events: Array<Record<string, unknown>>): SummaryFinding[] {
  const out: SummaryFinding[] = []
  for (const e of events) {
    const at = typeof e.at === "number" ? e.at : typeof e.turn === "number" ? e.turn : undefined
    if (e.type === "flag") out.push({ kind: "flag", text: `${e.criterion ? `${e.criterion}: ` : ""}${String(e.reason ?? e.kind ?? "flagged")}`, at })
    else if (e.type === "blocked") {
      const blocker = (e.blocker ?? {}) as { key?: string; reason?: string; count?: number }
      out.push({ kind: "blocked", text: `${blocker.key ?? "blocker"} — ${blocker.reason ?? "owner decision needed"}${blocker.count ? ` (raised ${blocker.count}×)` : ""}`, at })
    } else if (e.type === "verifier-empty") out.push({ kind: "verifier-empty", text: `verifier round ${e.round} returned an empty exchange (retried/recorded)`, at })
    else if (e.type === "verifier-fallback") out.push({ kind: "verifier-fallback", text: `${e.count} verdict(s) parsed from a prose-answering verifier`, at })
    else if (e.type === "amended") out.push({ kind: "amended", text: `contract amended (generation ${e.generation ?? "?"}): ${e.summary ?? ""}`, at })
    else if (e.type === "amend-proposed") out.push({ kind: "amend-proposed", text: `amendment proposed: ${e.summary ?? ""}`, at })
    else if (e.type === "budget_limited") out.push({ kind: "budget_limited", text: "the run hit its budget", at })
  }
  return out
}

export type SummaryInput = {
  contract: Contract
  state: RunState
  ledgerEvents?: Array<Record<string, unknown>>
  /** the project's cleo-linkage probe result; absent → install suggestion */
  cleo?: { source: string } | undefined
  /** T046: flagged unproven plan steps / scope.in items; empty until wired */
  scopeAudit?: ScopeAuditFlag[]
}

export function buildPostGoalSummary(input: SummaryInput): PostGoalSummary {
  const { contract, state } = input
  const criteria: SummaryCriterion[] = [...contract.criteria, ...contract.invariants].map((c) => {
    const s = state.criteria[c.id]
    const status = s?.status === "pass" ? ("pass" as const) : s?.status === "fail" ? ("fail" as const) : ("unknown" as const)
    const by = (s?.by as Provenance | undefined) ?? undefined
    return { id: c.id, statement: c.statement, status, by, detail: s?.detail, caveat: status === "pass" ? provenanceCaveat(by) : undefined }
  })
  const caveats = criteria.filter((c) => c.caveat).map((c) => `${c.id} — ${c.caveat}`)
  const scopeAudit = input.scopeAudit ?? []
  const findings = findingsFromLedger(input.ledgerEvents ?? [])
  const proven = criteria.filter((c) => c.status === "pass").length

  const followUps: string[] = []
  if (state.status === "complete") {
    followUps.push("Start the next goal: /goal new <what you want done> — the non-goals below are the ready-made backlog.")
  } else if (state.status === "needs_review") {
    followUps.push("Resolve the review: /goal approve <C#> (final) or /goal reject <C#> <why>, then /goal verify.")
  } else if (state.status === "budget_limited") {
    followUps.push("Raise the budget in goal.yaml and start a new run, or wrap up: /goal archive after aborting.")
  }
  if (scopeAudit.length) followUps.push("Break the discussed-but-unproven items out into a follow-up goal so they stop riding on this one.")
  followUps.push("Decompose long-running work with CLEO" + (input.cleo ? " (this project is already linked; keep tasks completing with evidence)." : ": this project has no .cleo workspace — installing it gives goals a task board that outlives any single run (the link stays optional and CLI-only)."))

  const headline =
    state.status === "complete"
      ? `goal complete — ${proven}/${criteria.length} criteria proven${caveats.length ? `, ${caveats.length} with provenance caveats` : ""}`
      : `goal ${state.status} — ${proven}/${criteria.length} criteria proven, ${criteria.length - proven} not yet`

  const lines: string[] = []
  lines.push(`# Post-goal summary — ${contract.title}`)
  lines.push(`${headline} · ${state.turn} turn(s)`)
  lines.push("")
  lines.push(`Outcome (as contracted): ${contract.outcome}`)
  lines.push("")
  lines.push("## Criteria")
  for (const c of criteria) {
    lines.push(`- ${label(c.status)} ${c.id} [${c.by ?? "unattributed"}] ${c.statement}${c.caveat ? `\n    caveat: ${c.caveat}` : ""}${c.status !== "pass" && c.detail ? `\n    ${c.detail.split("\n")[0]}` : ""}`)
  }
  if (scopeAudit.length) {
    lines.push("")
    lines.push("## Scope audit — discussed but unproven (flagged, not blocking)")
    for (const f of scopeAudit) lines.push(`- ${f.kind === "step" ? `plan step ${f.id}` : `scope.in ${f.id}`} — ${f.title}: ${f.why}`)
  }
  if (contract.non_goals.length) {
    lines.push("")
    lines.push("## Non-goals (deliberately not done)")
    for (const ng of contract.non_goals) lines.push(`- ${ng}`)
  }
  if (findings.length) {
    lines.push("")
    lines.push("## Mid-run findings")
    for (const f of findings) lines.push(`- ${f.kind}: ${f.text}`)
  }
  if (caveats.length) {
    lines.push("")
    lines.push("## Provenance caveats")
    for (const c of caveats) lines.push(`- ${c}`)
  }
  lines.push("")
  lines.push("## Follow-ups")
  for (const f of followUps) lines.push(`- ${f}`)

  return {
    slug: state.slug,
    title: state.title,
    status: state.status,
    turns: state.turn,
    headline,
    criteria,
    caveats,
    scopeAudit,
    nonGoals: contract.non_goals,
    findings,
    followUps,
    text: lines.join("\n"),
  }
}
