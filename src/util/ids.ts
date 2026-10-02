// Message ids in OpenCode 2's native ascending format (12 hex chars of
// timestamp*4096+counter, then 14 base62 chars), so continuation prompts sort
// correctly in session history. Mirrors @opencode/schema identifier.ts.
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

export function ascendingId(prefix: string, timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++
  const value = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const time = Array.from({ length: 6 }, (_, i) => Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return `${prefix}_${time}${Array.from(bytes, (b) => CHARS[b % 62]).join("")}`
}

export const runId = () => ascendingId("run").slice(4, 16)
