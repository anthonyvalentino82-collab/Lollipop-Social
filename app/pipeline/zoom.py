"""Auto zoom: subtle push-ins on emphasised words."""
import re

import numpy as np

INTENSITY = {"subtle": 1.08, "medium": 1.15, "strong": 1.25}
STOP = set("a an the and or but so to of in on at for is are was were be it i you we they this that".split())


def plan_zooms(words: list[dict], energy_db: list[float], intensity: str = "medium",
               min_gap: float = 3.5) -> list[dict]:
    """Pick emphasis moments: loud, content-carrying words after a pause or at
    the start of a sentence. Each becomes an eased zoom segment that holds
    through the phrase and eases back out."""
    if not words:
        return []
    e = np.array(energy_db)
    z = (e - e.mean()) / (e.std() + 1e-6)
    scores = []
    for i, w in enumerate(words):
        bare = re.sub(r"\W", "", w["w"]).lower()
        s = z[i]
        if bare in STOP or len(bare) < 3:
            s -= 1.5
        if i == 0 or words[i - 1]["w"].endswith((".", "!", "?")) or w["start"] - words[i - 1]["end"] > 0.4:
            s += 0.7  # starts a new thought
        if w["w"].endswith("!"):
            s += 0.8
        s += min(0.6, (w["end"] - w["start"]) * 0.8)  # stretched-out words
        scores.append(s)

    target = INTENSITY.get(intensity, INTENSITY["medium"])
    segments, taken = [], []
    for i in np.argsort(scores)[::-1]:
        if scores[i] < 0.6:
            break
        t = words[i]["start"]
        if t < 0.8 or any(abs(t - x) < min_gap for x in taken):
            continue
        taken.append(t)
        # Hold until the phrase ends (pause / punctuation), max 2.8 s.
        j = i
        while j + 1 < len(words) and words[j + 1]["start"] - words[j]["end"] < 0.35 \
                and not words[j]["w"].endswith((".", "!", "?")) and words[j + 1]["end"] - t < 2.8:
            j += 1
        strong = scores[i] > 2.0
        segments.append({
            "start": round(max(0, t - 0.12), 3),
            "end": round(max(t + 0.8, words[j]["end"]), 3),
            "scale": round(target + (0.05 if strong else 0), 3),
            "rin": 0.18 if strong else 0.45,   # big moments punch in faster
            "rout": 0.6,
        })
    return sorted(segments, key=lambda s: s["start"])
