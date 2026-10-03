// T033 — admission-time existence and similarity probes (council
// 20261003T162655Z-800c52ca): before a new slug is formed, /goal new checks
// whether this intent already exists (exact slug or title) and surfaces
// similar goals ranked, so duplicate intent is caught at the door. Pure and
// unit-tested; the registry supplies candidates across live AND archived
// goals (existence must survive archiving).

const STOP = new Set([
  "the", "a", "an", "to", "for", "of", "and", "or", "in", "on", "at", "is", "are", "be", "it", "its",
  "this", "that", "with", "as", "by", "from", "you", "we", "our", "your", "make", "get", "set", "up",
])

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t))
}

/** Jaccard overlap of token sets — cheap, order-free, good enough at goal scale. */
export function similarity(a: string, b: string): number {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (!A.size || !B.size) return 0
  let shared = 0
  for (const t of A) if (B.has(t)) shared += 1
  return shared / (A.size + B.size - shared)
}

export type Candidate = { slug: string; title: string; status?: string; archived?: boolean; project?: string }

export type Match = Candidate & { score: number; matched: string[] }

/** Exact existence: same slug, or a title that is the query verbatim (case-insensitive). */
export function exactExists(query: string, slugHint: string, candidates: Candidate[]): Candidate | undefined {
  const q = query.trim().toLowerCase()
  return candidates.find((c) => c.slug === slugHint.trim().toLowerCase() || c.title.trim().toLowerCase() === q)
}

/** Ranked similar goals above the threshold, best first, capped. */
export function similarGoals(query: string, candidates: Candidate[], threshold = 0.34, limit = 5): Match[] {
  const tokens = new Set(tokenize(query))
  return candidates
    .map((c) => {
      const hay = `${c.slug} ${c.title}`
      const score = similarity(query, hay)
      const matched = [...tokens].filter((t) => tokenize(hay).includes(t))
      return { ...c, score, matched }
    })
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** The note /goal new prepends when the probe finds anything worth surfacing. */
export function admissionNote(query: string, slugHint: string, candidates: Candidate[]): string | undefined {
  const exact = exactExists(query, slugHint, candidates)
  const similar = similarGoals(query, candidates).filter((m) => !exact || m.slug !== exact.slug)
  if (!exact && !similar.length) return undefined
  const lines = ["[goal admission probe]"]
  if (exact) lines.push(`EXISTS already: ${exact.slug} — "${exact.title}" (${exact.status ?? "draft"}${exact.archived ? ", archived" : ""}). Do not duplicate it: continue, resume or supersede it instead.`)
  for (const m of similar) lines.push(`similar (${m.score.toFixed(2)}): ${m.slug} — "${m.title}" (${m.status ?? "draft"}${m.archived ? ", archived" : ""}) — consider superseding it with supersedes: ${m.slug}@<lock> if this replaces it.`)
  lines.push("Surface these to the owner as options before forming a new slug: start fresh · continue/resume the existing goal · supersede it.")
  return lines.join("\n")
}
