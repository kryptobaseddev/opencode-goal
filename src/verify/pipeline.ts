// Completion is decided here, never by the worker. Order: contract integrity →
// host-run checks → independent verifier (with quotes the host re-reads) →
// owner sign-off for human criteria.
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, normalize, relative } from "node:path"
import type { Check, Contract, Criterion } from "../contract/types"
import { isHostCheck } from "../contract/types"
import { lockOf } from "../contract/parse"
import type { RunState } from "../engine/state"
import { changedSince, isRepo, matchesAny } from "../util/git"
import { runShell, tail, type ShellResult } from "../util/shell"

export type CheckResult = { id: string; pass: boolean; by: "host" | "verifier" | "verifier-fallback" | "human"; detail: string; raw?: unknown }

export type VerifierVerdict = { id: string; verdict: "proven" | "not_proven" | "contradicted"; reason?: string; evidence: Array<{ path: string; quote: string }> }
export type VerifierRun = (input: { contract: Contract; state: RunState; criteria: Criterion[]; host: CheckResult[] }) => Promise<{ verdicts: VerifierVerdict[]; by?: "verifier" | "verifier-fallback"; error?: string }>

export type VerifyOutcome = {
  passed: boolean
  needsHuman: string[]
  results: CheckResult[]
  integrity: string[]
  lines: string[]
}

const inside = (root: string, path: string) => {
  const full = normalize(isAbsolute(path) ? path : join(root, path))
  const rel = relative(root, full)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? full : rel === "" ? full : undefined
}

export async function runHostCheck(check: Check, root: string, base: string | undefined, shell = runShell): Promise<{ pass: boolean; detail: string; raw?: unknown }> {
  switch (check.kind) {
    case "command": {
      const runs: ShellResult[] = []
      for (let i = 0; i < (check.runs ?? 1); i++) {
        const result = await shell(check.run, root, check.timeout ?? 300)
        runs.push(result)
        const why = failure(check, result)
        if (why) return { pass: false, detail: `run ${i + 1}/${check.runs ?? 1}: ${why}\n${tail(result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ""))}`, raw: runs }
      }
      const last = runs.at(-1)!
      return { pass: true, detail: `exit ${last.exit} in ${(last.ms / 1000).toFixed(1)}s${(check.runs ?? 1) > 1 ? ` ×${check.runs}` : ""}`, raw: runs }
    }
    case "file": {
      const path = inside(root, check.path)
      if (!path) return { pass: false, detail: `${check.path} is outside the project` }
      const exists = existsSync(path)
      const want = check.exists !== false
      return { pass: exists === want, detail: `${check.path} ${exists ? "exists" : "does not exist"}` }
    }
    case "contains": {
      const path = inside(root, check.path)
      if (!path || !existsSync(path)) return { pass: false, detail: `${check.path} not found` }
      const text = readFileSync(path, "utf8")
      const ok = check.text ? text.includes(check.text) : new RegExp(check.regex!, "m").test(text)
      return { pass: ok, detail: ok ? `${check.path} contains the expected ${check.text ? "text" : "pattern"}` : `${check.path} lacks ${check.text ? `"${check.text}"` : `/${check.regex}/`}` }
    }
    case "absent": {
      const paths = check.paths?.length ? check.paths : ["."]
      const quoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
      const cmd = isRepo(root)
        ? `git grep -n -I -E -e ${quoted(check.pattern)} -- ${paths.map(quoted).join(" ")} ':(exclude).opencode/goals'`
        : `grep -rnIE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=goals -e ${quoted(check.pattern)} ${paths.map(quoted).join(" ")}`
      const result = await shell(cmd, root, 120)
      const matches = result.stdout.trim().split("\n").filter(Boolean)
      if (result.exit > 1) return { pass: false, detail: `search failed (exit ${result.exit}): ${tail(result.stderr, 3)}` }
      return { pass: matches.length === 0, detail: matches.length ? `${matches.length} match(es) remain, e.g.\n${matches.slice(0, 5).join("\n")}` : "no matches" }
    }
    case "diff": {
      const changed = changedSince(root, base).filter((f) => matchesAny(f, check.paths))
      return { pass: changed.length === 0, detail: changed.length ? `changed since start: ${changed.slice(0, 10).join(", ")}` : "unchanged since start" }
    }
    default:
      return { pass: false, detail: `${check.kind} is not a host check` }
  }
}

function failure(check: Extract<Check, { kind: "command" }>, result: ShellResult): string | undefined {
  if (result.timedOut) return `timed out after ${check.timeout ?? 300}s`
  const e = check.expect ?? { exit: 0 }
  if (e.exit !== undefined && result.exit !== e.exit) return `exit ${result.exit}, expected ${e.exit}`
  if (e.stdout_contains && !result.stdout.includes(e.stdout_contains)) return `output lacks "${e.stdout_contains}"`
  if (e.stdout_regex && !new RegExp(e.stdout_regex, "m").test(result.stdout)) return `output does not match /${e.stdout_regex}/`
  return undefined
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim()

/** The host re-reads every quote the verifier cites; an unverifiable quote is no evidence. */
export function checkQuotes(root: string, verdict: VerifierVerdict): { ok: boolean; why?: string } {
  if (verdict.verdict !== "proven") return { ok: false, why: verdict.reason ?? verdict.verdict }
  if (!verdict.evidence.length) return { ok: false, why: "verifier cited no evidence" }
  for (const item of verdict.evidence) {
    const path = inside(root, item.path)
    if (!path || !existsSync(path)) return { ok: false, why: `cited file ${item.path} does not exist` }
    if (!item.quote || collapse(item.quote).length < 8) return { ok: false, why: `quote from ${item.path} is too short to check` }
    if (!collapse(readFileSync(path, "utf8")).includes(collapse(item.quote))) return { ok: false, why: `quoted text not found in ${item.path}` }
  }
  return { ok: true }
}

export async function verifyClaim(contract: Contract, state: RunState, deps: { root: string; contractText: string; verifier?: VerifierRun; shell?: typeof runShell }): Promise<VerifyOutcome> {
  const { root } = deps
  const integrity: string[] = []
  if (lockOf(deps.contractText) !== state.lock)
    integrity.push(
      "goal.yaml changed since the run started: the contract is sha256-locked for this run. The owner re-locks an amended contract with /goal amend confirm (audit-trailed, generation-bound) or aborts and starts fresh; a worker must never edit .opencode/goals/.",
    )
  if (contract.protect.length) {
    const touched = changedSince(root, state.base.commit).filter((f) => matchesAny(f, contract.protect))
    if (touched.length) integrity.push(`protected paths were modified: ${touched.slice(0, 10).join(", ")}. Restore them; do not change the oracle to make it pass.`)
  }

  const results: CheckResult[] = []
  for (const c of [...contract.criteria, ...contract.invariants]) {
    if (!isHostCheck(c.check)) continue
    const r = await runHostCheck(c.check, root, state.base.commit, deps.shell)
    results.push({ id: c.id, pass: r.pass, by: "host", detail: r.detail, raw: r.raw })
  }

  const semantic = contract.criteria.filter((c) => c.check.kind === "verifier")
  const strictExtra = contract.verification.mode === "strict" ? contract.criteria.filter((c) => isHostCheck(c.check) && results.find((r) => r.id === c.id)?.pass) : []
  // T051: an owner-approved criterion (pass by:human) is final — the owner
  // outranks the verifier, so re-verification must respect it permanently
  // instead of re-running a child that can stomp an explicit sign-off.
  const toVerify = (contract.verification.mode === "host" ? [] : [...semantic, ...strictExtra]).filter(
    (c) => !(state.criteria[c.id]?.status === "pass" && state.criteria[c.id]?.by === "human"),
  )
  for (const c of [...semantic, ...strictExtra]) {
    if (state.criteria[c.id]?.status === "pass" && state.criteria[c.id]?.by === "human")
      results.push({ id: c.id, pass: true, by: "human", detail: "approved by the owner (final)" })
  }
  if (toVerify.length) {
    if (!deps.verifier) {
      for (const c of toVerify) results.push({ id: c.id, pass: false, by: "verifier", detail: "verifier unavailable; failing closed" })
    } else {
      const run = await deps.verifier({ contract, state, criteria: toVerify, host: results }).catch((error) => ({ verdicts: [] as VerifierVerdict[], by: "verifier" as const, error: String(error) }))
      for (const c of toVerify) {
        const v = run.verdicts.find((x) => x.id === c.id)
        const checked = v ? checkQuotes(root, v) : { ok: false, why: run.error ? `verifier failed: ${run.error}` : "verifier returned no verdict" }
        const prior = results.findIndex((r) => r.id === c.id)
        const entry: CheckResult = { id: c.id, pass: checked.ok, by: run.by === "verifier-fallback" ? "verifier-fallback" : "verifier", detail: checked.ok ? `proven with ${v!.evidence.length} quote(s)${run.by === "verifier-fallback" ? " (parsed fallback verdict)" : ""}` : checked.why ?? "not proven", raw: v }
        if (prior >= 0) {
          // strict mode: the verifier must agree with the passing host check
          if (!checked.ok) results[prior] = { ...entry, detail: `host passed but verifier disagrees: ${entry.detail}` }
        } else results.push(entry)
      }
    }
  }

  const needsHuman = contract.criteria.filter((c) => c.check.kind === "human" && !(state.criteria[c.id]?.status === "pass" && state.criteria[c.id]?.by === "human")).map((c) => c.id)
  for (const c of contract.criteria.filter((c) => c.check.kind === "human")) {
    const s = state.criteria[c.id]
    results.push({ id: c.id, pass: s?.status === "pass" && s.by === "human", by: "human", detail: s?.status === "pass" ? "approved by the owner" : "awaiting owner sign-off" })
  }

  const required = new Set([...contract.criteria.filter((c) => c.essential).map((c) => c.id), ...contract.invariants.map((c) => c.id)])
  const failed = results.filter((r) => required.has(r.id) && !r.pass && r.by !== "human")
  const passed = integrity.length === 0 && failed.length === 0 && needsHuman.filter((id) => required.has(id)).length === 0

  const lines: string[] = []
  for (const i of integrity) lines.push(`INTEGRITY: ${i}`)
  for (const r of results) {
    if (r.pass) continue
    const c = [...contract.criteria, ...contract.invariants].find((x) => x.id === r.id)
    lines.push(`${r.id} ${required.has(r.id) ? "FAILED" : "not met (optional)"} [${r.by}] ${c?.statement ?? ""}\n    ${r.detail.replace(/\n/g, "\n    ")}`)
  }
  if (!lines.length) lines.push("All required criteria passed.")
  return { passed, needsHuman, results, integrity, lines }
}
