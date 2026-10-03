# Runs the real OpenCode TUI in a pseudo-terminal against the spike host and
# prints the rendered text (ANSI stripped). Usage: python3 spikes/tui-capture.py [seconds]
import json, os, pty, re, select, signal, struct, sys, time, fcntl, termios
info = json.load(open(os.path.join(os.path.dirname(__file__), "..", ".tmp", "spikes", "tui-host.json")))
seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 15
binary = os.path.expanduser("~/.opencode/bin/opencode")
env = dict(info["env"]); env["TERM"] = "xterm-256color"; env["COLUMNS"] = "180"; env["LINES"] = "50"
pid, fd = pty.fork()
if pid == 0:
    os.chdir(info["project"])
    os.execve(binary, [binary, "--server", info["url"], "--session", info["sessionID"]], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
os.kill(pid, signal.SIGWINCH)
buf = b""; end = time.time() + seconds
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if fd in r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk: break
        buf += chunk
        # answer cursor-position / device-attribute queries so the TUI does not stall
        if b"\x1b[6n" in chunk: os.write(fd, b"\x1b[1;1R")
        if b"\x1b[c" in chunk: os.write(fd, b"\x1b[?62;c")
os.kill(pid, signal.SIGTERM)
text = buf.decode("utf-8", "replace")
open(os.path.join(os.path.dirname(__file__), "..", ".tmp", "spikes", "tui-raw.txt"), "w").write(text)
plain = re.sub(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>NOMc78]", "", text)
# T014: the dashboard panel is the default goal surface at >120 cols (it takes
# the right pane; the sidebar card is hidden by design). Probe the panel's
# sections (GOAL header, Criteria board, Plan, Timeline) plus the footer pill.
for marker in ["PROBE-PANEL-GOAL", "PROBE-PANEL-CRITERIA", "PROBE-PANEL-TIMELINE", "PROBE-PILL", "PONG", "tick="]:
    if marker == "PROBE-PANEL-GOAL":
        found = ("GOAL" in plain and "paused" in plain)
    elif marker == "PROBE-PANEL-CRITERIA":
        found = "Criteria" in plain
    elif marker == "PROBE-PANEL-TIMELINE":
        found = "Timeline" in plain
    elif marker == "PROBE-PILL":
        found = bool(re.search(r"◎ .{0,4}\d+/\d+", plain))
    else:
        found = marker in plain
    print(marker, "FOUND" if found else "missing")
print("bytes:", len(buf))
m = re.findall(r"PONG [^\r\n\x1b]{0,40}|PROBE-PILL \d+|Timeline|Criteria", plain)
print("samples:", sorted(set(m))[:10])
