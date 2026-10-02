// Worktree fingerprints: progress is measured by authoritative state change,
// not by how much the model talked.
import { createHash } from "node:crypto"

const GOAL_STATE = ":(exclude).opencode/goals"

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  return { ok: result.exitCode === 0, out: result.stdout.toString() }
}

export const isRepo = (cwd: string) => git(cwd, ["rev-parse", "--is-inside-work-tree"]).out.trim() === "true"

export const headCommit = (cwd: string): string | undefined => {
  const r = git(cwd, ["rev-parse", "HEAD"])
  return r.ok ? r.out.trim() : undefined
}

/** Hash of HEAD + staged/unstaged diff + untracked file list, excluding goal state. */
export function fingerprint(cwd: string): string | undefined {
  if (!isRepo(cwd)) return undefined
  const head = git(cwd, ["rev-parse", "HEAD"]).out
  const diff = git(cwd, ["diff", "HEAD", "--no-color", "--", ".", GOAL_STATE]).out
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", GOAL_STATE]).out
  const contents = untracked
    .split("\n")
    .filter(Boolean)
    .slice(0, 500)
    .map((file) => {
      try {
        const stat = Bun.file(`${cwd}/${file}`)
        return `${file}:${stat.size}:${stat.lastModified}`
      } catch {
        return file
      }
    })
  return createHash("sha256").update(head).update(diff).update(contents.join("\n")).digest("hex").slice(0, 20)
}

/** Files changed relative to `base` (committed, staged, unstaged and untracked). */
export function changedSince(cwd: string, base: string | undefined): string[] {
  if (!isRepo(cwd)) return []
  const files = new Set<string>()
  if (base) for (const f of git(cwd, ["diff", "--name-only", base, "--", ".", GOAL_STATE]).out.split("\n")) if (f) files.add(f)
  for (const f of git(cwd, ["diff", "--name-only", "HEAD", "--", ".", GOAL_STATE]).out.split("\n")) if (f) files.add(f)
  for (const f of git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", GOAL_STATE]).out.split("\n")) if (f) files.add(f)
  return [...files].sort()
}

/** Minimal glob → RegExp (supports **, *, ?). */
export function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"
        i += glob[i + 2] === "/" ? 2 : 1
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

export const matchesAny = (file: string, globs: string[]) => globs.some((g) => globToRegExp(g.replace(/^\.\//, "")).test(file))
