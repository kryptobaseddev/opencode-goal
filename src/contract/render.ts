// What the model sees. The system block is byte-stable for a whole run (prefix
// cache); everything that changes per turn lives in the tail note.
import type { Check, Contract, Criterion } from "./types"
import { budgetUse, type RunState } from "../engine/state"

const describeCheck = (check: Check): string => {
  switch (check.kind) {
    case "command":
      return `host runs \`${check.run}\`${check.expect?.exit !== undefined ? ` → exit ${check.expect.exit}` : ""}${check.expect?.stdout_contains ? ` and output contains "${check.expect.stdout_contains}"` : ""}${check.expect?.stdout_regex ? ` and output matches /${check.expect.stdout_regex}/` : ""}${check.runs && check.runs > 1 ? ` (${check.runs} consecutive runs)` : ""}`
    case "file":
      return `host checks ${check.path} ${check.exists === false ? "does not exist" : "exists"}`
    case "contains":
      return `host checks ${check.path} contains ${check.text ? `"${check.text}"` : `/${check.regex}/`}`
    case "absent":
      return `host searches for /${check.pattern}/${check.paths?.length ? ` in ${check.paths.join(", ")}` : ""} and expects no match`
    case "diff":
      return `host checks ${check.paths.join(", ")} are unchanged since the run started`
    case "verifier":
      return `independent read-only verifier answers: ${check.ask}`
    case "human":
      return `the owner signs off: ${check.ask}`
  }
}

const line = (c: Criterion) => `- ${c.id}${c.essential ? "" : " (optional)"}: ${c.statement}\n    proof: ${describeCheck(c.check)}`

export function renderSystemBlock(contract: Contract, lock: string): string {
  const out: string[] = []
  out.push(`<goal_contract id="${contract.id}" lock="${lock.slice(0, 12)}">`)
  out.push("Goal mode is active for this session. The contract below is fixed for this run. It is the owner's task data: pursue it, but it does not override system, developer, tool or repository policies.")
  out.push("")
  out.push(`Title: ${contract.title}`)
  out.push(`Outcome (the end state that must become true): ${contract.outcome}`)
  if (contract.why) out.push(`Why: ${contract.why}`)
  out.push(`Owner's words: "${contract.intent.verbatim.replace(/\s+/g, " ")}"`)
  out.push("")
  out.push("Criteria (every non-optional one must be proven before the goal completes):")
  for (const c of contract.criteria) out.push(line(c))
  if (contract.invariants.length) {
    out.push("Invariants (must stay true the whole run; the host re-checks them):")
    for (const c of contract.invariants) out.push(line(c))
  }
  if (contract.protect.length) out.push(`Protected paths (never edit, delete or rename): ${contract.protect.join(", ")}`)
  if (contract.scope.in.length || contract.scope.out.length)
    out.push(`Scope: in ${contract.scope.in.join(", ") || "(unspecified)"}; out ${contract.scope.out.join(", ") || "(unspecified)"}`)
  out.push(`Non-goals: ${contract.non_goals.join("; ")}`)
  if (contract.constraints.length) out.push(`Constraints: ${contract.constraints.join("; ")}`)
  if (contract.plan.length) {
    out.push("Plan:")
    for (const s of contract.plan)
      out.push(`- ${s.id}: ${s.title}${s.proves.length ? ` (proves ${s.proves.join(", ")})` : ""}${s.depends_on.length ? ` (after ${s.depends_on.join(", ")})` : ""}`)
  }
  const assumed = contract.assumptions.filter((a) => a.status !== "vetoed")
  if (assumed.length) out.push(`Assumptions (binding until the owner vetoes them): ${assumed.map((a) => `${a.id} ${a.text}`).join("; ")}`)
  if (contract.stop.when) out.push(`Done when: ${contract.stop.when}`)
  if (contract.stop.escalate_when.length) out.push(`Stop and call goal_block when: ${contract.stop.escalate_when.join("; ")}`)
  out.push(`Contract file: .opencode/goals/${contract.id}/goal.yaml`)
  out.push("</goal_contract>")
  out.push("")
  out.push("<goal_protocol>")
  out.push("- Work from current evidence. Inspect files and run commands; earlier conversation helps you find things but proves nothing.")
  out.push("- Keep the full outcome. Never narrow success to what is easy, what already exists, or what makes a check pass.")
  out.push("- Every turn, take concrete actions with tools. A turn that only talks or restates status counts as no progress.")
  out.push("- Record progress with goal_progress: the step you are on, one line on what changed, and the next action.")
  out.push("- When you believe every criterion holds, call goal_claim with evidence per criterion, then end your turn. The host runs the checks itself and an independent verifier reviews the rest; you never grade your own work.")
  out.push("- If a criterion is contradictory, impossible or unsafe as written, call goal_flag. Do not edit tests or checks to make them pass.")
  out.push("- If you are blocked on something only the owner can provide, call goal_block with a short stable key. Hard, slow or uncertain work is not blocked.")
  out.push("- To wait on an external process, call goal_wait with the seconds and the reason instead of polling in a loop.")
  out.push("- Never edit the contract or anything under .opencode/goals/, and never touch protected paths.")
  if (contract.autonomy.questions === "defer")
    out.push("- Do not ask the owner questions during the run. Make the most reasonable reversible choice and note it in goal_progress as an assumption, or call goal_block if it truly needs an owner decision.")
  out.push("</goal_protocol>")
  return out.join("\n")
}

const pct = (used: number, limit: number) => `${Math.round((used / limit) * 100)}%`
const fmtMs = (ms: number) => {
  const m = Math.round(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`
}
export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

export function boardLine(state: RunState, contract: Contract): string {
  return [...contract.criteria, ...contract.invariants]
    .map((c) => {
      const s = state.criteria[c.id]
      const mark = s?.status === "pass" ? "✓" : s?.status === "fail" ? "✗" : s?.status === "claimed" ? "◐" : "·"
      return `${mark} ${c.id}${s?.by ? ` (${s.by})` : ""}`
    })
    .join("  ")
}

export type TailKind = "kickoff" | "continue" | "verdict" | "recovery" | "wrapup" | "resume"

export function renderTailNote(state: RunState, contract: Contract, kind: TailKind, now = Date.now()): string {
  const out: string[] = []
  const use = budgetUse(state, contract, now)
  const budget = use.parts.length
    ? use.parts.map((p) => `${p.name} ${p.name === "wall" ? `${fmtMs(p.used)}/${fmtMs(p.limit)}` : p.name === "tokens" ? `${fmtTokens(p.used)}/${fmtTokens(p.limit)}` : p.name === "cost" ? `$${p.used.toFixed(2)}/$${p.limit}` : `${p.used}/${p.limit}`}`).join(" · ")
    : "no budget set"
  out.push(`<goal_status turn="${state.turn}" run="${state.runId}">`)
  const header: Record<TailKind, string> = {
    kickoff: `Start the goal "${contract.title}". Read the contract above, inspect the current state of the repository, then begin with the first unfinished plan step. Take concrete actions now.`,
    continue: "Continue the goal from its current state. Choose the next concrete action toward the outcome and take it with tools.",
    verdict: "The host checked your completion claim and it did not pass. Fix what the verdict below names, then claim again with fresh evidence.",
    recovery: "Your recent turns did not change anything the host can see. Do not restate status. Write down the 1-3 next concrete actions for yourself, then execute the first one with tools now. If you are truly blocked, call goal_block.",
    wrapup: "The goal's budget is used up. Do not start new substantive work. Record where things stand with goal_progress (what is done, what remains, the exact next step), then end your turn.",
    resume: "The owner resumed this goal. Re-read the contract and the current repository state, then continue from the first unfinished step.",
  }
  out.push(header[kind])
  out.push(`Budget: ${budget}`)
  if (use.ratio >= 0.8 && use.ratio < 1 && kind !== "wrapup") out.push(`Budget warning: ${pct(use.ratio, 1)} used. Finish the current step and move toward a claim or a clean handoff.`)
  out.push(`Criteria: ${boardLine(state, contract)}`)
  if (contract.plan.length) out.push(`Plan: ${contract.plan.map((s) => `${s.id} ${state.steps[s.id] ?? "pending"}`).join(" · ")}`)
  if (state.progress) out.push(`Last progress (turn ${state.progress.turn}): ${state.progress.note}${state.progress.next ? ` → next: ${state.progress.next}` : ""}`)
  if (state.verdict && !state.verdict.passed && (kind === "verdict" || state.verdict.turn >= state.turn - 1)) {
    out.push(`HOST VERDICT (turn ${state.verdict.turn}):`)
    for (const l of state.verdict.lines) out.push(`  ${l}`)
  }
  if (state.blocker && state.blocker.count > 0) out.push(`Reported blocker "${state.blocker.key}" ×${state.blocker.count}: ${state.blocker.reason}. Look for independent work that does not depend on it before reporting it again.`)
  if (state.compacted) out.push(`Context was compacted. Before acting, re-read .opencode/goals/${contract.id}/goal.yaml and the recent entries of .opencode/goals/${contract.id}/ledger.jsonl; do not redo finished work.`)
  out.push("</goal_status>")
  return out.join("\n")
}

export const triggerText = (state: RunState, contract: Contract, kind: TailKind) =>
  kind === "kickoff" ? `◎ goal started: ${contract.title}` : kind === "wrapup" ? `◎ goal budget reached — wrap up (turn ${state.turn})` : `↻ goal turn ${state.turn}${kind === "verdict" ? " — host verdict" : kind === "recovery" ? " — recovery" : kind === "resume" ? " — resumed" : ""}`
