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
    # Pick the emphasis words (spread out: each zoom now takes several seconds).
    chosen = []
    for i in np.argsort(scores)[::-1]:
        if scores[i] < 0.6:
            break
        t = words[i]["start"]
        if t < 1.2 or any(abs(t - words[k]["start"]) < max(min_gap, 5.0) for k in chosen):
            continue
        chosen.append(i)
    chosen.sort(key=lambda k: words[k]["start"])

    # Organic, cinematic moves: slow push in, hold through the phrase, slow drift back out.
    # Each zoom gets a different feel (and never the same one twice in a row), so there's no
    # pattern: slow in / slow out, quicker in / slow out, slow in / quicker out, medium…
    # The random choices are seeded by the words, so the same video always gets the same zooms.
    import random
    rng = random.Random(" ".join(w["w"] for w in words[:40]))
    moves = [((2.2, 3.2), (2.2, 3.4)), ((0.9, 1.3), (2.0, 3.0)), ((2.0, 3.0), (0.9, 1.3)), ((1.4, 2.0), (1.4, 2.0))]
    segments, last_move, free_at = [], None, 0.0
    for i in chosen:
        t = words[i]["start"]
        move = rng.choice([m for m in range(len(moves)) if m != last_move])
        rin = rng.uniform(*moves[move][0])
        rout = rng.uniform(*moves[move][1])
        # Fully zoomed in right as the emphasised word lands (start the push-in before it). If the
        # previous zoom is still settling, start later and keep the full slow move: never rush it.
        start = max(free_at, t - rin * 0.9)
        # Hold until the phrase ends (pause / punctuation), up to ~3.5 s.
        j = i
        while j + 1 < len(words) and words[j + 1]["start"] - words[j]["end"] < 0.35 \
                and not words[j]["w"].endswith((".", "!", "?")) and words[j + 1]["end"] - t < 3.5:
            j += 1
        end = max(start + rin + 0.6, words[j]["end"] + rng.uniform(0.1, 0.6))
        if start >= end:
            continue
        amount = (target - 1) * rng.uniform(0.75, 1.15) * (1.15 if scores[i] > 2.0 else 1.0)
        segments.append({"start": round(start, 3), "end": round(end, 3), "scale": round(1 + amount, 3),
                         "rin": round(rin, 2), "rout": round(rout, 2), "smooth": True})
        last_move, free_at = move, end + rout + rng.uniform(0.4, 1.5)  # rest before the next one
    return segments
