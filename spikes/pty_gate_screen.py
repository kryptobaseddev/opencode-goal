# extracted from pty-gate.py for probe reuse
import re
ROWS, COLS = 50, 180
class Screen:
    """Minimal VT100 screen reconstruction: enough for cursor-addressed paints."""
    def __init__(self) -> None:
        self.last_feed = 0.0
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
        import time as _t
        self.last_feed = _t.time()
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
