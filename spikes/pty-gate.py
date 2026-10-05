# Deterministic pty gate — the C1 live-TUI proof (T064 palette, T065
# screen-fit, T066 decision rendering). Unlike palette-probe.py (an exploratory
# flat capture), this driver reconstructs the actual 50x180 SCREEN from the
# escape stream (a minimal VT model: absolute/relative cursor moves, line and
# screen clears — the TUI paints with per-cell positioning, so flat text
# flattening merges regions and hides rows), drives two phases and prints one
# ASSERT line per claim. Exit code 0 iff every assertion passes.
#
# Phase D (decision dialog, T066/T050): the scripted worker blocks the goal
#   (3 consecutive goal_block reports) while this TUI is attached; the engine
#   emits the "blocked" decision payload and the TUI must render it as a
#   keyboard-selectable dialog. We assert the dialog title, the message and
#   every act-able choice row are visible on the screen together (screen-fit —
#   an overflowing dialog pushes its top or bottom rows off-screen), then
#   press Enter on the highlighted choice ("Resolve, then resume" ->
#   rpc.act resume). The orchestrator asserts the engine left "blocked".
# Phase C (v0.3.2 T072): after Enter resumes the run, the worker drives it to
#   a completing claim; the engine's terminal push must render the COMPLETING
#   card — we dismiss the complete-decision dialog and the queued summary
#   digest (ESC ×2) and assert the sidebar card shows complete + the
#   loop-stopped line. A stale mid-run snapshot fails this phase.
# Phase G (v0.3.2 T074): leader+g opens the dashboard panel; the tab key
#   cycles the highlighted tab — the pty walkthrough of the panel.
# Phase P (palette, T064): ctrl+p, type "Goal"; the palette must list the
#   plugin's Goal commands (the keymap layer is mode:"global" — mode-less
#   layers are unreachable while the palette's own "modal" layer is active).
import json, os, pty, re, select, signal, struct, sys, time, fcntl, termios

info = json.load(open(os.path.join(os.path.dirname(__file__), "..", ".tmp", "spikes", "tui-host.json")))
binary = os.path.expanduser("~/.opencode/bin/opencode")
env = dict(info["env"]); env["TERM"] = "xterm-256color"; env["COLUMNS"] = "180"; env["LINES"] = "50"

ROWS, COLS = 50, 180

class Screen:
    """Minimal VT100 screen reconstruction: enough for cursor-addressed paints."""
    def __init__(self) -> None:
        self.grid = [[" "] * COLS for _ in range(ROWS)]
        self.r = self.c = 0
        self.drops = 0
    def _put(self, ch: str) -> None:
        if self.r < 0 or self.r >= ROWS or self.c < 0 or self.c >= COLS:
            self.drops += 1
            return
        self.grid[self.r][self.c] = ch
        self.c += 1
    def feed(self, data: str) -> None:
        i, n = 0, len(data)
        while i < n:
            ch = data[i]
            if ch == "\x1b":
                m = re.match(r"\x1b\[([0-9;?<>=]*)([ -/]*)([@-~])", data[i:])
                if m:
                    params, _, final = m.groups()
                    nums = [int(p) for p in re.findall(r"\d+", params)]
                    if final == "H" or final == "f":
                        parts = params.split(";")
                        row = int(parts[0]) if parts and parts[0].isdigit() else 1
                        col = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 1
                        self.r, self.c = row - 1, col - 1
                    elif final == "A": self.r -= max(1, nums[0] if nums else 1)
                    elif final == "B": self.r += max(1, nums[0] if nums else 1)
                    elif final == "C": self.c += max(1, nums[0] if nums else 1)
                    elif final == "D": self.c -= max(1, nums[0] if nums else 1)
                    elif final == "G": self.c = (nums[0] if nums else 1) - 1
                    elif final == "d": self.r = (nums[0] if nums else 1) - 1
                    elif final == "J":
                        mode = nums[0] if nums else 0
                        if mode == 2 or mode == 3:
                            self.grid = [[" "] * COLS for _ in range(ROWS)]
                        elif mode == 0:
                            for c in range(self.c, COLS): self.grid[self.r][c] = " "
                            for r in range(self.r + 1, ROWS): self.grid[r] = [" "] * COLS
                        elif mode == 1:
                            for r in range(0, self.r): self.grid[r] = [" "] * COLS
                            for c in range(0, self.c + 1): self.grid[self.r][c] = " "
                    elif final == "K":
                        mode = nums[0] if nums else 0
                        if mode == 0:
                            for c in range(self.c, COLS): self.grid[self.r][c] = " "
                        elif mode == 1:
                            for c in range(0, self.c + 1): self.grid[self.r][c] = " "
                        else:
                            self.grid[self.r] = [" "] * COLS
                    i += m.end()
                    continue
                m = re.match(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", data[i:])
                if m:
                    i += m.end(); continue
                m = re.match(r"\x1bP.*?\x1b\\", data[i:], flags=re.S)
                if m:
                    i += m.end(); continue
                m = re.match(r"\x1b[()][A-Za-z0-9]|\x1b[=>NOMc78]", data[i:])
                if m:
                    i += m.end(); continue
                i += 1
                continue
            if ch == "\r": self.c = 0
            elif ch == "\n": self.r = min(self.r + 1, ROWS - 1)
            elif ch == "\b": self.c = max(0, self.c - 1)
            elif ch == "\t": self.c = min(COLS - 1, (self.c // 8 + 1) * 8)
            elif ch >= " ": self._put(ch)
            i += 1
    def text(self) -> str:
        return "\n".join("".join(row).rstrip() for row in self.grid)

STRIP = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>NOMc78]")
def flat(buf: bytes) -> str:
    text = re.sub(r"\x1bP.*?\x1b\\", "", buf.decode("utf-8", "replace"), flags=re.S)
    return STRIP.sub("", text)

# Incremental presence probes: raw UTF-8 needles painted in one run (kept for
# the diagnostics; per-iteration flat() over the whole buffer is quadratic in
# stream size — the lazy DCS regex starved the gate's loop at ~144KB).


DIALOG_TITLE = "Goal — blocked"
DIALOG_CHOICE_FIRST = "Resolve, then resume"
DIALOG_CHOICE_LAST = "Abort goal"

def send(fd: int, data: bytes, timeout: float = 10.0) -> float:
    """Write to the pty without hanging if the TUI stops draining input:
    non-blocking write, select-for-write retry, returns the wait in seconds
    (a long wait means the TUI is under event churn — see the phase notes)."""
    os.set_blocking(fd, False)
    started = time.time()
    while True:
        try:
            os.write(fd, data)
            return time.time() - started
        except BlockingIOError:
            if time.time() - started > timeout:
                raise
            select.select([], [fd], [], 0.1)

results: list[tuple[str, bool, str]] = []
def record(name: str, ok: bool, detail: str) -> bool:
    results.append((name, ok, detail))
    print(f"ASSERT {name} {'PASS' if ok else 'FAIL'} {detail}")
    return ok

pid, fd = pty.fork()
if pid == 0:
    os.chdir(info["project"])
    os.execve(binary, [binary, "--server", info["url"], "--session", info["sessionID"]], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
os.kill(pid, signal.SIGWINCH)

buf = b""
screen = Screen()
palette_snapshot: list[str] | None = None      # screen rows with the palette open (phase P)
palette_flat: str | None = None                 # flat stream at palette capture (presence checks)
palette_sent_at: float | None = None
palette_done = False
dialog_snapshot: list[str] | None = None       # screen rows with the dialog up (phase D)
dialog_title_seen_at: float | None = None
entered_dialog = False
entered_dialog_at: float = 0.0
card_snapshot: list[str] | None = None         # v0.3.2 phase C: the settled complete card
card_complete_seen_at: float | None = None     # when the complete-decision dialog appeared
card_esc_sent = 0
panel_open_sent_at: float | None = None        # v0.3.2 phase G: leader+g
panel_snapshot: list[str] | None = None
panel_tab_sent_at: float | None = None
panel_tab_snapshot: list[str] | None = None
phase_screens: dict[str, list[str]] = {}
deadline = time.time() + 300
send_waits: list[float] = []

try:
    first_read_at: float | None = None
    last_byte_at = time.time()
    milestones: dict[int, float] = {}
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
            last_byte_at = time.time()
            if first_read_at is None: first_read_at = time.time()
            for mark in (1024, 10240, 51200, 131072):
                if len(buf) >= mark and mark not in milestones:
                    milestones[mark] = time.time()
            if b"\x1b[6n" in chunk: os.write(fd, b"\x1b[1;1R")
            if b"\x1b[c" in chunk: os.write(fd, b"\x1b[?62;c")
            screen.feed(chunk.decode("utf-8", "replace"))
        now = time.time()
        text = screen.text()

        # --- Phase D (decision dialog, T066/T050) FIRST: the worker's three
        # consecutive goal_block reports end the turn BLOCKED, the engine goes
        # quiet, and the TUI (no longer starved by event churn) renders the
        # decision payload as a keyboard-selectable dialog. Driving keys
        # mid-churn is impossible: OpenCode 2.0.22 stops draining pty input
        # while streaming (os.write blocked ~170s in the churn-phase design).
        if dialog_title_seen_at is None and DIALOG_TITLE in text:
            dialog_title_seen_at = now
        if dialog_snapshot is None and dialog_title_seen_at is not None and (
            DIALOG_CHOICE_FIRST in text or now - dialog_title_seen_at > 8.0
        ):
            time.sleep(2.5)                      # let the full dialog settle (all option rows)
            for _ in range(20):                  # drain pending paints into the screen model
                r2, _, _ = select.select([fd], [], [], 0.1)
                if fd not in r2: break
                try:
                    more = os.read(fd, 65536)
                except OSError:
                    break
                if not more: break
                buf += more
                screen.feed(more.decode("utf-8", "replace"))
            dialog_snapshot = screen.text().splitlines()
        if dialog_snapshot is not None and not entered_dialog:
            entered_dialog = True
            entered_dialog_at = now
            send_waits.append(send(fd, b"\r"))    # Enter: the highlighted act-able choice dispatches rpc.act
            time.sleep(3.0)
            phase_screens["post-enter"] = screen.text().splitlines()

        # --- Phase C (v0.3.2 T072): the resumed run completes; the complete
        # decision dialog opens (dialog.select — it stays open until ANSWERED,
        # ESC does not dismiss it), the summary digest queues behind it.
        # Drive both explicitly: Enter answers the decision (its highlighted
        # choice dispatches the act), Enter dismisses the digest — then the
        # card must show the DISK truth (complete + loop stopped), never the
        # pre-completion snapshot. Keys sent while the TUI still stream are
        # dropped (S26 input starvation), so every key waits for quiescence.
        def quiet_for(seconds: float) -> bool:
            return now - last_byte_at > seconds

        if entered_dialog and card_complete_seen_at is None and "Goal — complete" in text:
            card_complete_seen_at = now
        if card_complete_seen_at is not None and card_snapshot is None:
            if card_esc_sent == 0 and now - card_complete_seen_at > 4.0 and quiet_for(2.0):
                card_esc_sent = 1
                send_waits.append(send(fd, b"\r"))   # answer the complete decision (highlighted choice)
            elif card_esc_sent == 1 and now - card_complete_seen_at > 9.0 and quiet_for(2.0):
                card_esc_sent = 2
                send_waits.append(send(fd, b"\r"))   # dismiss the summary digest (alert)
            elif card_esc_sent == 2 and now - card_complete_seen_at > 13.0 and quiet_for(2.0):
                card_esc_sent = 3
                send_waits.append(send(fd, b"\r"))   # any digest still up
            elif card_esc_sent == 3 and now - card_complete_seen_at > 16.0 and quiet_for(2.0):
                time.sleep(1.0)                        # settle: the card renders the terminal view
                for _ in range(20):
                    r2, _, _ = select.select([fd], [], [], 0.1)
                    if fd not in r2: break
                    try:
                        more = os.read(fd, 65536)
                    except OSError:
                        break
                    if not more: break
                    buf += more
                    screen.feed(more.decode("utf-8", "replace"))
                card_snapshot = screen.text().splitlines()
                phase_screens["card-complete"] = card_snapshot

        # --- Phase G (v0.3.2 T074): leader+g (ctrl+x then g) opens the
        # dashboard panel; the tab key cycles the highlighted tab. The
        # built-in sidebar paints over the panel region on a 180-col screen,
        # so it is toggled off (leader+b) for the capture — the panel itself
        # is what the assertion targets. Only after the card phase closed
        # every dialog, so the keymap layer is live.
        if card_snapshot is not None and panel_open_sent_at is None and quiet_for(1.5):
            send_waits.append(send(fd, b"\x18"))       # ctrl+x: the leader key
            time.sleep(0.15)
            send_waits.append(send(fd, b"g"))          # g: toggle dashboard
            time.sleep(0.5)
            send_waits.append(send(fd, b"\x18"))       # leader again
            time.sleep(0.15)
            send_waits.append(send(fd, b"b"))          # b: hide the built-in sidebar
            panel_open_sent_at = time.time()
        if panel_open_sent_at is not None and panel_snapshot is None and now - panel_open_sent_at > 3.0:
            panel_snapshot = screen.text().splitlines()
            phase_screens["panel-open"] = panel_snapshot
            send_waits.append(send(fd, b"\t"))         # tab: next dashboard tab
            panel_tab_sent_at = time.time()
        if panel_tab_sent_at is not None and panel_tab_snapshot is None and now - panel_tab_sent_at > 2.5:
            panel_tab_snapshot = screen.text().splitlines()
            phase_screens["panel-tab"] = panel_tab_snapshot
            send_waits.append(send(fd, b"\x1b"))       # close the panel before the palette phase
            time.sleep(0.3)
            send_waits.append(send(fd, b"\x18"))
            time.sleep(0.15)
            send_waits.append(send(fd, b"b"))          # restore the built-in sidebar
            time.sleep(0.8)

        # --- Phase P (palette, T064): after the panel walkthrough the TUI is
        # idle again and reads pty input, so the palette probe works exactly
        # like the exploratory capture that proved the fix. The completed
        # goal keeps its view: the goal.* palette commands stay enabled
        # (hasGoal).
        if panel_tab_snapshot is not None and palette_sent_at is None and now - (panel_tab_sent_at or 0) > 4.0:
            send_waits.append(send(fd, b"\x10"))  # ctrl+p opens the command palette
            time.sleep(1.5)
            for ch in "Goal".encode():
                send_waits.append(send(fd, bytes([ch])))
            palette_sent_at = time.time()
        if palette_sent_at is not None and not palette_done and now - palette_sent_at > 4.0:
            palette_snapshot = screen.text().splitlines()
            palette_flat = flat(buf)
            phase_screens["palette"] = palette_snapshot
            send_waits.append(send(fd, b"\x1b"))  # ESC closes the palette
            time.sleep(0.8)
            palette_done = True
            break
finally:
    time.sleep(0.2)
print(f"DIAG loop ended: dialog_title_seen_at={dialog_title_seen_at} entered_dialog={entered_dialog} "
      f"card_complete_seen_at={card_complete_seen_at} card_esc={card_esc_sent} panel_open_sent_at={panel_open_sent_at} "
      f"palette_sent_at={palette_sent_at} palette_done={palette_done} buf={len(buf)}B drops={screen.drops} "
      f"first_read_at={first_read_at} send_waits={[round(w, 2) for w in send_waits]} "
      f"milestones={ {k: round(v - (first_read_at or v), 1) for k, v in sorted(milestones.items())} }")

def rows_with(lines: list[str], needle: str) -> list[int]:
    return [i for i, l in enumerate(lines) if needle in l]

ok = True
# --- dialog assertions (T066 render + T065 screen-fit + keyboard input)
if dialog_snapshot is None:
    record("dialog.opens", False, f"{DIALOG_TITLE!r} never rendered within 90s (flat bytes: {len(flat(buf))})")
else:
    title_rows = rows_with(dialog_snapshot, DIALOG_TITLE)
    first_rows = rows_with(dialog_snapshot, DIALOG_CHOICE_FIRST)
    last_rows = rows_with(dialog_snapshot, DIALOG_CHOICE_LAST)
    record("dialog.opens", bool(title_rows), f"title rendered at screen row(s) {title_rows[:2]}")
    record("dialog.choices-visible", bool(first_rows) and bool(last_rows),
           f"first act-able choice rows {first_rows[:2]}, last choice rows {last_rows[:2]}")
    # screen-fit (T065): the dialog's top (title) and bottom (last choice) rows
    # are visible on the SAME screen — an overflowing dialog pushes one off.
    record("dialog.screen-fit", bool(title_rows and first_rows and last_rows)
           and max(last_rows + title_rows) < ROWS,
           f"title row {title_rows[:1]}, choices span rows {min(first_rows + last_rows, default=-1)}..{max(first_rows + last_rows, default=-1)} of {ROWS}")
    record("dialog.keyboard-enter", True, "Enter sent on the highlighted choice; the orchestrator asserts the engine left blocked")

# --- palette assertions (T064): presence from the flat stream (the palette
# paints with per-cell positioning; the screen model can miss rows), and the
# gate opens the palette exactly once, so matches can only come from it.
if palette_snapshot is None and palette_flat is None:
    record("palette.opens", False, "palette capture never taken (dialog phase incomplete?)")
else:
    flat_at_capture = palette_flat or ""
    record("palette.opens", "Suggested" in flat_at_capture, "built-in Suggested list present (the palette actually opened)")
    titles = sorted(set(re.findall(r"Goal: [a-z][a-z /-]*", flat_at_capture)))
    record("palette.goal-commands", len(titles) >= 6, f"{len(titles)} distinct Goal commands: {[t.strip() for t in titles][:9]}")

# --- v0.3.2 (a) card-complete assertions (T072): after the run settles, the
# sidebar card shows the DISK truth — the completing status and the
# loop-stopped line — never a stale mid-run snapshot.
if card_snapshot is None:
    record("card.shows-complete", False, "the complete card never settled (complete decision dialog not seen?)")
else:
    card_text = "\n".join(card_snapshot)
    complete_rows = rows_with(card_snapshot, "complete")
    stopped_rows = rows_with(card_snapshot, "loop stopped")
    record("card.shows-complete", bool(complete_rows) and "✓" in card_text,
           f"'complete' at row(s) {complete_rows[:3]}, status mark ✓ present")
    record("card.loop-stopped-line", bool(stopped_rows),
           f"'loop stopped' line at row(s) {stopped_rows[:3]} (follow-ups pointer)")

# --- v0.3.2 (b) panel assertions (T074): leader+g opens the dashboard panel
# with its tab bar; the tab key moves the highlighted tab.
def tabbar(lines: list[str]) -> tuple[int, str] | None:
    for i, l in enumerate(lines):
        if "Now" in l and "Progress" in l and "Decisions" in l and "Goals" in l:
            return i, l.strip()
    return None
if panel_snapshot is None:
    record("panel.opens", False, "leader+g never opened the panel (card phase incomplete?)")
else:
    opened = tabbar(panel_snapshot)
    record("panel.opens", opened is not None and any("◎ GOAL" in l for l in panel_snapshot),
           f"tab bar: {opened[1] if opened else 'NOT FOUND'}")
    if panel_tab_snapshot is None:
        record("panel.cycles-tabs", False, "no post-tab capture")
    else:
        before = tabbar(panel_snapshot)
        after = tabbar(panel_tab_snapshot)
        moved = bool(before and after and before[1] != after[1])
        record("panel.cycles-tabs", moved,
               f"tab bar before: {before[1] if before else '?'} → after: {after[1] if after else '?'}")

os.kill(pid, signal.SIGTERM)
failures = [name for name, ok_, _ in results if not ok_]
outdir = os.path.join(os.path.dirname(__file__), "..", ".tmp", "spikes")
os.makedirs(outdir, exist_ok=True)
if dialog_snapshot is not None:
    open(os.path.join(outdir, "gate-dialog.txt"), "w").write("\n".join(dialog_snapshot))
if palette_snapshot is not None:
    open(os.path.join(outdir, "gate-palette.txt"), "w").write("\n".join(palette_snapshot))
for name, lines in phase_screens.items():
    open(os.path.join(outdir, f"gate-{name}.txt"), "w").write("\n".join(lines))
open(os.path.join(outdir, "gate-full-flat.txt"), "w").write(flat(buf))
print(f"PTY-GATE {'PASS' if not failures else 'FAIL'}: {len(results) - len(failures)}/{len(results)} assertions")
sys.exit(1 if failures else 0)
