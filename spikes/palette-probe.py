# Palette probe: run the real OpenCode TUI in a pty against the spike host,
# then INJECT keystrokes — ctrl+p (palette) + a query — and capture what the
# palette actually shows. Usage: python3 spikes/palette-probe.py [query]
import json, os, pty, re, select, signal, struct, sys, time, fcntl, termios

info = json.load(open(os.path.join(os.path.dirname(__file__), "..", ".tmp", "spikes", "tui-host.json")))
query = sys.argv[1] if len(sys.argv) > 1 else "Goal"
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 14
binary = os.path.expanduser("~/.opencode/bin/opencode")
env = dict(info["env"]); env["TERM"] = "xterm-256color"; env["COLUMNS"] = "180"; env["LINES"] = "50"
pid, fd = pty.fork()
if pid == 0:
    os.chdir(info["project"])
    os.execve(binary, [binary, "--server", info["url"], "--session", info["sessionID"]], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
os.kill(pid, signal.SIGWINCH)
buf = b""
end = time.time() + seconds
sent_palette = sent_query = False
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if fd in r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk: break
        buf += chunk
        if b"\x1b[6n" in chunk: os.write(fd, b"\x1b[1;1R")
        if b"\x1b[c" in chunk: os.write(fd, b"\x1b[?62;c")
    elapsed = end - time.time()
    if not sent_palette and elapsed < seconds - 6:
        os.write(fd, b"\x10")  # ctrl+p opens the command palette
        sent_palette = True
    if sent_palette and not sent_query and elapsed < seconds - 4.5:
        for ch in query.encode():
            os.write(fd, bytes([ch]))
        sent_query = True
os.kill(pid, signal.SIGTERM)
text = buf.decode("utf-8", "replace")
out = os.path.join(os.path.dirname(__file__), "..", ".tmp", "spikes")
open(os.path.join(out, "palette-raw.txt"), "w").write(text)
plain = re.sub(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>NOMc78]", "", text)
open(os.path.join(out, "palette-plain.txt"), "w").write(plain)
lines = [re.sub(r"\s+", " ", l).strip() for l in plain.splitlines() if l.strip()]
hits = [l for l in lines if "goal" in l.lower()]
print("GOAL-RELATED LINES AFTER PALETTE + QUERY:", len(hits))
for h in hits[:20]: print(" ", h[:150])
print("plain bytes:", len(plain))
