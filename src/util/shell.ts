// Runs owner-declared check commands in the owner's login shell, so PATH and
// toolchains match their terminal rather than the background service.
export type ShellResult = { exit: number; stdout: string; stderr: string; timedOut: boolean; ms: number }

const LIMIT = 64 * 1024

async function collect(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return ""
  const decoder = new TextDecoder()
  let out = ""
  for await (const chunk of stream) {
    if (out.length < LIMIT * 2) out += decoder.decode(chunk, { stream: true })
  }
  return out.length > LIMIT ? `${out.slice(0, LIMIT / 4)}\n…[truncated ${out.length - LIMIT / 2} chars]…\n${out.slice(-LIMIT / 4)}` : out
}

export async function runShell(command: string, cwd: string, timeoutSeconds = 300): Promise<ShellResult> {
  const shell = process.env.SHELL && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/sh"
  const started = Date.now()
  const child = Bun.spawn([shell, "-lc", command], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CI: process.env.CI ?? "1" } })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, Math.max(1, timeoutSeconds) * 1000)
  const [stdout, stderr] = await Promise.all([collect(child.stdout), collect(child.stderr)])
  const exit = await child.exited
  clearTimeout(timer)
  return { exit: timedOut ? 124 : exit, stdout, stderr, timedOut, ms: Date.now() - started }
}

export const tail = (text: string, lines = 12, chars = 1200) => {
  const t = text.trimEnd().split("\n").slice(-lines).join("\n")
  return t.length > chars ? `…${t.slice(-chars)}` : t
}
