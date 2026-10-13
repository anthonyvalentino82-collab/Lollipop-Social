"""Auto zoom: a few big, slow push-ins on emphasised words."""
import re

import numpy as np

INTENSITY = {"subtle": 1.14, "medium": 1.22, "strong": 1.30}
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
    import random
    rng = random.Random(" ".join(w["w"] for w in words[:40]))
    total = words[-1]["end"]
    # Few, big, unhurried zooms: about one per 30 s (1 in a 15-30 s reel, 2 in a 60 s reel),
    # each one a slow push in, a long hold, a slow drift out, then 10-15 s of stillness.
    max_n = max(1, int(round(total / 30.0)))
    min_sep = max(min_gap, 18.0)  # push-in + hold + drift-out + rest

    def pick(threshold):
        chosen = []
        for i in np.argsort(scores)[::-1]:
            if scores[i] < threshold or len(chosen) >= max_n:
                break
            t = words[i]["start"]
            if t < 2.5 or t > total - 4.0 or any(abs(t - words[k]["start"]) < min_sep for k in chosen):
                continue
            chosen.append(i)
        return chosen

    chosen = pick(0.6) or pick(-99)  # always at least one zoom when there's room for it
    chosen.sort(key=lambda k: words[k]["start"])

    # Each zoom gets its own feel (never the same twice in a row), so there's no pattern:
    # slow in / slow out, slower in / quicker out, quicker in / slower out. Seeded by the words,
    # so the same video always gets the same zooms.
    moves = [((3.0, 4.0), (3.0, 4.0)), ((3.5, 4.5), (2.2, 2.8)), ((2.2, 2.8), (3.5, 4.5))]
    segments, last_move, free_at = [], None, 0.0
    for i in chosen:
        t = words[i]["start"]
        move = rng.choice([m for m in range(len(moves)) if m != last_move])
        rin = rng.uniform(*moves[move][0])
        rout = rng.uniform(*moves[move][1])
        # Fully zoomed in right as the emphasised word lands (start the push-in before it).
        start = max(free_at, t - rin)
        # Stay in through the phrase: at least 3-5 s, up to 6.5 s, ending on a word boundary.
        hold = rng.uniform(3.0, 5.0)
        j = i
        while j + 1 < len(words) and words[j + 1]["end"] - t < 6.5 and \
                (words[j]["end"] - t < hold or not (words[j]["w"].endswith((".", "!", "?"))
                                                    or words[j + 1]["start"] - words[j]["end"] > 0.35)):
            j += 1
        end = min(max(start + rin + hold, words[j]["end"] + 0.2), total - rout)
        if end <= start + rin:
            continue
        amount = (target - 1) * rng.uniform(0.9, 1.1)
        segments.append({"start": round(start, 3), "end": round(end, 3), "scale": round(1 + amount, 3),
                         "rin": round(rin, 2), "rout": round(rout, 2), "smooth": True})
        last_move, free_at = move, end + rout + rng.uniform(10.0, 15.0)  # long rest before the next one
    return segments
