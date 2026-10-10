"""Time-based math shared by preview and export.

Every function here has a twin in static/js/timeline.js — keep them in sync so
what you see on the phone is what lands in the MP4.
"""
import re


def ease(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


# ---------- captions ----------

def build_caption_lines(words: list[dict], max_words: int = 3) -> list[dict]:
    lines, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        sentence_end = bool(re.search(r"[.!?,;:]$", w["w"]))
        pause = nxt is not None and nxt["start"] - w["end"] > 0.6
        if len(cur) >= max_words or sentence_end or pause or nxt is None:
            lines.append({
                "id": f"l{len(lines)}",
                "start": cur[0]["start"], "end": cur[-1]["end"],
                "words": [dict(x) for x in cur],
            })
            cur = []
    return lines


def caption_at(lines: list[dict], t: float):
    """(line, active_word_index, seconds_since_line_start) or None."""
    for i, ln in enumerate(lines):
        nxt = lines[i + 1] if i + 1 < len(lines) else None
        hold_end = ln["end"] + 0.25
        if nxt is not None:
            hold_end = nxt["start"] if nxt["start"] - ln["end"] < 0.5 else min(hold_end, nxt["start"])
        if ln["start"] <= t < hold_end:
            active = 0
            for j, w in enumerate(ln["words"]):
                if w["start"] <= t:
                    active = j
            return ln, active, t - ln["start"]
    return None


# ---------- zoom ----------

def zoom_scale_at(zoom: dict, t: float) -> float:
    if not zoom.get("enabled", True):
        return 1.0
    best = 1.0
    for seg in zoom.get("segments", []):
        s, e = seg["start"], seg["end"]
        rin, rout = seg.get("rin", 0.4), seg.get("rout", 0.5)
        if t < s or t > e + rout:
            continue
        env = ease((t - s) / rin) if t < s + rin else (1.0 if t <= e else 1 - ease((t - e) / rout))
        best = max(best, 1 + (seg["scale"] - 1) * env)
    return best


def face_at(track: list, t: float) -> tuple[float, float]:
    """Face centre (normalised 0-1 in source) at time t. track = [[t, x, y], ...]."""
    if not track:
        return 0.5, 0.4
    if t <= track[0][0]:
        return track[0][1], track[0][2]
    for a, b in zip(track, track[1:]):
        if a[0] <= t <= b[0]:
            k = (t - a[0]) / max(1e-6, b[0] - a[0])
            return a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k
    return track[-1][1], track[-1][2]


def crop_rect(src_w: int, src_h: int, zoom: dict, track: list, t: float):
    """Source-pixel rectangle (x, y, w, h) that becomes the 9:16 output frame."""
    aspect = 9 / 16
    if src_w / src_h > aspect:
        h = src_h
        w = h * aspect
    else:
        w = src_w
        h = w / aspect
    s = zoom_scale_at(zoom, t)
    w, h = w / s, h / s
    fx, fy = face_at(track, t)
    cx = fx * src_w
    cy = fy * src_h + 0.1 * h  # keep the face a little above centre
    x = min(max(cx - w / 2, 0), src_w - w)
    y = min(max(cy - h / 2, 0), src_h - h)
    return x, y, w, h


# ---------- b-roll ----------

def broll_at(broll: list[dict], t: float):
    for b in broll:
        if not b.get("removed") and b["start"] <= t < b["end"]:
            return b
    return None


# ---------- text layout ----------

def parse_headline(text: str) -> list[list[tuple[str, bool]]]:
    """'YOUR *NEXT 10 YEARS*\\nARE HIDDEN' -> lines of (word, is_accent).
    Words wrapped in *asterisks* get the accent colour."""
    lines = []
    accent = False
    for raw_line in text.split("\n"):
        words = []
        for tok in raw_line.split():
            starts, ends = tok.startswith("*"), tok.endswith("*") and len(tok) > 1
            word = tok.strip("*")
            if starts:
                accent = True
            if word:
                words.append((word, accent))
            if ends:
                accent = False
        lines.append(words)
    return lines


def wrap_words(words: list, measure, max_width: float) -> list[list]:
    """Greedy word-wrap; `measure(list_of_words)` returns pixel width."""
    out, cur = [], []
    for w in words:
        if cur and measure(cur + [w]) > max_width:
            out.append(cur)
            cur = [w]
        else:
            cur.append(w)
    if cur:
        out.append(cur)
    return out
