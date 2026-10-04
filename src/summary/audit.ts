// T046 — the completion scope audit. The owner's 2026-10-04 gap: a contract's
// criteria can all pass while a plan step that proves nothing (proves:[])
// never happened and a scope.in line maps to no criterion at all — the run
// "completed" a smaller goal than the one discussed. Per the council
// decision this ships as a FLAGGED CAVEAT in the post-goal summary: items
// are surfaced as discussed-but-unproven, completion is never blocked by
// them (deliberately loose plans must not deadlock).
import type { Contract, Criterion } from "../contract/types"
import type { RunState } from "../engine/state"
import type { ScopeAuditFlag } from "./build"

const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "when", "must", "shall", "your", "you", "are", "was", "were", "has", "have", "its", "their", "than", "then", "over", "under", "before", "after", "every", "each", "which", "what", "also", "onto", "any", "all", "not", "but", "out", "off", "via", "per", "new", "next", "them", "they", "some", "more", "most", "less", "least", "very", "just", "only", "done", "work", "owner", "agent"])

/** Lowercase meaningful tokens (≥4 chars, naive plural/past stripping). */
export function tokens(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9+#./-]+/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 4 && !STOP.has(t))
        .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t.length > 4 && t.endsWith("ed") ? t.slice(0, -2) : t)),
    ),
  ]
}

/** The searchable text of a criterion: statement plus its check body. */
function criterionText(c: Criterion): string {
  const check = c.check as Record<string, unknown>
  return `${c.statement} ${Object.values(check).filter((v) => typeof v === "string").join(" ")}`
}

/** A scope.in line maps to a criterion when one mentions the other, or they
 *  share ≥2 meaningful tokens. Deterministic and explainable — the audit
 *  says WHY an item was flagged, never just that it was. */
export function scopeItemMaps(item: string, criteria: Criterion[]): boolean {
  const itemNorm = item.toLowerCase().trim()
  const itemTokens = tokens(item)
  for (const c of criteria) {
    const text = criterionText(c)
    const textNorm = text.toLowerCase()
    // a direct mention either way (guarded against tiny substrings)
    if (itemNorm.length >= 8 && (textNorm.includes(itemNorm) || itemNorm.includes(textNorm))) return true
    if (tokens(text).filter((t) => itemTokens.includes(t)).length >= 2) return true
  }
  return false
}

/**
 * Flag discussed-but-unproven items:
 * - plan steps with proves:[] and no sibling evidence of work (the step was
 *   never recorded done or active in the run's progress state), and
 * - scope.in lines mapping to no criterion.
 * Returns the flags; the caller surfaces them as caveats. Never blocks.
 */
export function completionAudit(contract: Contract, state: RunState): ScopeAuditFlag[] {
  const flags: ScopeAuditFlag[] = []
  const all = [...contract.criteria, ...contract.invariants]
  for (const step of contract.plan) {
    if (step.proves.length) continue // proves criteria — those outcomes speak
    const sibling = state.steps[step.id]
    if (sibling === "done" || sibling === "active") continue // recorded work exists
    flags.push({
      kind: "step",
      id: step.id,
      title: step.title,
      why: `proves no criterion and was never recorded done or active (${sibling ?? "pending"}) — discussed but unproven`,
    })
  }
  for (const item of contract.scope.in) {
    if (scopeItemMaps(item, all)) continue
    flags.push({ kind: "scope", id: item, title: item, why: "no criterion statement or check maps to it — discussed but unproven" })
  }
  return flags
}
