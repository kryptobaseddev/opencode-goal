# Probe: does leader+g (ctrl+x then g) open the plugin's dashboard panel on a
# quiet TUI? Isolates the bind from the gate's dialog churn.
import json, os, pty, re, select, signal, struct, sys, time, fcntl, termios

info = json.load(open(os.path.join(os.path.dirname(__file__), "..", ".tmp", "spikes", "tui-host.json")))
binary = os.path.expanduser("~/.opencode/bin/opencode")
env = dict(info["env"]); env["TERM"] = "xterm-256color"; env["COLUMNS"] = "180"; env["LINES"] = "50"
ROWS, COLS = 50, 180

sys.path.insert(0, os.path.dirname(__file__))
from pty_gate_screen import Screen  # noqa: E402

pid, fd = pty.fork()
if pid == 0:
    os.chdir(info["project"])
    os.execve(binary, [binary, "--server", info["url"], "--session", info["sessionID"]], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
os.kill(pid, signal.SIGWINCH)

screen = Screen()
buf = b""
deadline = time.time() + 60
sent = False
sent_at = 0.0
try:
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            if b"\x1b[6n" in chunk: os.write(fd, b"\x1b[1;1R")
            if b"\x1b[c" in chunk: os.write(fd, b"\x1b[?62;c")
            screen.feed(chunk.decode("utf-8", "replace"))
        text = screen.text()
        now = time.time()
        if not sent and "Goal" in text and now - (screen.last_feed or 0) > 2 and b"Goal" in buf:
            sent = True
            sent_at = now
            # route A: the palette (proven path) — ctrl+p, type, enter
            os.write(fd, b"\x10")
            time.sleep(1.5)
            for ch in b"toggle dashboard":
                os.write(fd, bytes([ch]))
                time.sleep(0.05)
            time.sleep(1.5)
            os.write(fd, b"\r")
            print("sent palette toggle-dashboard at", round(now % 100, 1))
        if sent and now - sent_at > 4 and "+b" not in open("/tmp/probe-stage", "a+").read() if False else False:
            pass
        if sent and now - sent_at > 4:
            open("/dev/null", "a")
            print("=== screen after palette toggle-dashboard ===")
            print(text)
            # hide the built-in sidebar (leader+b) in case it covers the panel
            os.write(fd, b"\x18")
            time.sleep(0.15)
            os.write(fd, b"b")
            time.sleep(2.5)
            r2, _, _ = select.select([fd], [], [], 0.5)
            while fd in r2:
                try:
                    chunk2 = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk2: break
                buf += chunk2
                screen.feed(chunk2.decode("utf-8", "replace"))
                r2, _, _ = select.select([fd], [], [], 0.3)
            print("=== screen after leader+b (sidebar hidden) ===")
            print(screen.text())
            break
finally:
    pass
os.kill(pid, signal.SIGTERM)
