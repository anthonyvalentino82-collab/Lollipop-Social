"""Auto B-roll: choose moments from the transcript, then fetch matching footage
from your own uploaded clips or from Pexels / Pixabay (free, licensed for commercial use)."""
import json
import random
import re
import threading
import uuid
from pathlib import Path

import httpx

from .. import config
from .media import run, thumbnail

STOP = set("""a an the and or but so to of in on at for is are was were be been being it its i me my you your
we our they them their he she his her this that these those with from as by not no yes just really very
can could would should will do does did done have has had get got going go gonna want know think like
about what when where who why how all any some more most than then there here now well also because
into out up down over again only one two make made thing things way lot right okay yeah
years year today tomorrow yesterday week weeks month months day days time times people person
everyone everybody someone something anything nothing everything clients client customers guys
little great good better best bad need needs help helps start started looking look said say says
tell talk talking sure actually literally maybe kind sort much many lots stuff point part
first last next another every each still even back here there where which while
makes making gets getting goes going gives giving take takes taking come comes coming want wants
know knows think thinks feel keep keeps put let lets easier faster harder bigger smaller easy hard
helped helping buy buying sell selling""".split())


def plan_moments(lines: list[dict], duration: float, clip_tags: list[str]) -> tuple[list[dict], str]:
    """Returns (moments, method). Each moment: {start, end, query, clip_tag}."""
    if not lines:
        return [], "none"
    if config.ANTHROPIC_API_KEY:
        try:
            return _plan_with_claude(lines, duration, clip_tags), "claude"
        except Exception as exc:  # fall back rather than failing the whole auto edit
            print(f"[broll] Claude planning failed, using keyword fallback: {exc}")
    return _plan_with_keywords(lines, duration, clip_tags), "keywords"


def _window(lines, a, b):
    a, b = max(0, min(a, len(lines) - 1)), max(0, min(b, len(lines) - 1))
    a, b = min(a, b), max(a, b)
    start, end = lines[a]["start"], lines[b]["end"]
    if end - start < 1.8:
        end = start + 1.8
    return round(start, 3), round(min(end, start + 4.5), 3)


def _plan_with_claude(lines, duration, clip_tags):
    import anthropic

    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    transcript = "\n".join(f'{i}: [{ln["start"]:.1f}s] {" ".join(w["w"] for w in ln["words"])}'
                           for i, ln in enumerate(lines))
    max_moments = max(1, min(6, round(duration / 10)))
    prompt = (
        "You are editing a short vertical talking-head video for social media. Pick moments where "
        "cutting away to B-roll footage would illustrate what the speaker is saying (the voice keeps "
        "playing). Choose concrete, visual ideas, never abstract words.\n\n"
        f"The creator makes videos about {config.BROLL_NICHE} for an American audience. Search terms "
        "must find footage that looks like the United States and fits that world: American suburban "
        "homes and neighborhoods, 'for sale' yard signs, real estate agents showing houses, couples "
        "signing mortgage papers, handing over house keys, families moving in, U.S. dollar bills, "
        "Wall Street, the Federal Reserve, American city skylines, grocery prices, gas pumps, etc. "
        "Add words like 'american', 'usa' or 'suburban' when they help find U.S.-looking footage. "
        "Avoid generic or foreign-looking scenes, and avoid words with other meanings (say 'homebuyers' "
        "or 'married homeowners', not just 'couple', which also finds animals).\n\n"
        f"Rules: at most {max_moments} moments; skip the first 2 seconds (viewers need to see the "
        "speaker's face first); each moment spans 1-3 consecutive caption lines (about 2-4 seconds); "
        "leave at least 4 seconds between moments; B-roll should cover under a third of the video.\n"
        "`query` is a 2-4 word stock-footage search term; `alts` are 2 different search terms for the "
        "same moment (other angles on the idea), used when the first finds nothing new. "
        + (f"The creator has their own clips tagged: {', '.join(clip_tags)}. If one fits a moment, set "
           "`clip_tag` to that exact tag; otherwise set it to an empty string.\n" if clip_tags else
           "Always set `clip_tag` to an empty string.\n")
        + f"\nCaption lines (index: [start time] text):\n{transcript}"
    )
    schema = {
        "type": "object",
        "properties": {"moments": {"type": "array", "items": {
            "type": "object",
            "properties": {"first_line": {"type": "integer"}, "last_line": {"type": "integer"},
                           "query": {"type": "string"}, "alts": {"type": "array", "items": {"type": "string"}},
                           "clip_tag": {"type": "string"}},
            "required": ["first_line", "last_line", "query", "alts", "clip_tag"],
            "additionalProperties": False}}},
        "required": ["moments"], "additionalProperties": False,
    }
    resp = client.messages.create(
        model=config.CLAUDE_MODEL, max_tokens=4000,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
        messages=[{"role": "user", "content": prompt}],
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("model declined the request")
    data = json.loads(next(b.text for b in resp.content if b.type == "text"))
    out = []
    for m in data["moments"][:max_moments]:
        start, end = _window(lines, m["first_line"], m["last_line"])
        if start < 2.0:
            continue
        tag = m["clip_tag"] if m["clip_tag"] in clip_tags else ""
        out.append({"start": start, "end": end, "query": m["query"].strip()[:60], "clip_tag": tag,
                    "alts": [a.strip()[:60] for a in m.get("alts", []) if a.strip()][:3]})
    return _non_overlapping(out)


def _plan_with_keywords(lines, duration, clip_tags):
    """No-AI fallback: pick evenly spaced lines and search their most specific word."""
    candidates = []
    for i, ln in enumerate(lines):
        if ln["start"] < 2.0:
            continue
        text = " ".join(w["w"] for w in ln["words"]).lower()
        tag = next((t for t in clip_tags if t.lower() in text), "")
        words = [re.sub(r"[^a-z']", "", w["w"].lower()) for w in ln["words"]]
        if i + 1 < len(lines):  # look one line ahead so two-word ideas aren't split
            words += [re.sub(r"[^a-z']", "", w["w"].lower()) for w in lines[i + 1]["words"]]
        good = [len(w) >= 4 and w not in STOP for w in words]
        # Prefer two content words in a row ("mortgage rates", "dream home").
        pairs = [f"{words[j]} {words[j + 1]}" for j in range(len(words) - 1) if good[j] and good[j + 1]]
        singles = [w for w, g in zip(words, good) if g]
        query = pairs[0] if pairs else (max(singles, key=len) if singles else tag)
        if tag or query:
            candidates.append((i, tag, query))
    want = max(1, min(5, round(duration / 12)))
    if not candidates:
        return []
    step = max(1, len(candidates) // want)
    out = []
    for i, tag, kw in candidates[step // 2::step][:want]:
        start, end = _window(lines, i, i + 1)
        out.append({"start": start, "end": end, "query": kw, "clip_tag": tag,
                    "alts": random.sample(NICHE_QUERIES, 3)})
    # Tagged personal clips always win a slot.
    for i, tag, kw in candidates:
        if tag and not any(o["clip_tag"] == tag for o in out):
            start, end = _window(lines, i, i + 1)
            out.append({"start": start, "end": end, "query": kw, "clip_tag": tag})
    return _non_overlapping(sorted(out, key=lambda m: m["start"]))


def _non_overlapping(moments):
    out = []
    for m in sorted(moments, key=lambda m: m["start"]):
        if out and m["start"] < out[-1]["end"] + 1.0:
            continue
        out.append(m)
    return out


# Fitting, American-looking fallback searches (used when a moment's own terms find nothing new).
NICHE_QUERIES = [
    "american suburban house", "for sale sign house", "real estate agent showing house", "couple signing papers",
    "house keys handover", "family moving boxes", "new home front door", "neighborhood aerial usa",
    "american flag house porch", "dollar bills counting", "wall street new york", "stock market screen",
    "federal reserve building", "city skyline usa", "home renovation", "couple calculator bills",
    "grocery store prices", "gas station pump", "house construction", "luxury home interior",
    "young family new house", "home inspection", "kitchen remodel", "mortgage documents",
]

# Clips used in earlier videos, so every new video gets fresh footage.
_HIST = config.DATA_DIR / "broll_history.json"
_hist_lock = threading.Lock()


def used_before() -> set[str]:
    try:
        return set(json.loads(_HIST.read_text()))
    except (FileNotFoundError, ValueError):
        return set()


def remember(ids) -> None:
    ids = [i for i in ids if i]
    if not ids:
        return
    with _hist_lock:
        try:
            hist = json.loads(_HIST.read_text())
        except (FileNotFoundError, ValueError):
            hist = []
        hist = [i for i in hist if i not in ids] + ids
        _HIST.write_text(json.dumps(hist[-5000:]))


# Words too general to prove a clip matches (a pair of ducks is also a "couple").
GENERIC = set("""couple couples people person man men woman women young old happy new american usa us america
united states family families group adult adults kid kids child children beautiful closeup close up shot
video footage background view modern""".split())
# Never show these unless the search itself asks for them.
OFF_TOPIC = set("""animal animals bird birds duck ducks dog dogs cat cats wildlife insect insects fish horse horses cow
cows chicken chickens butterfly bee bees pet pets zoo jungle safari""".split())


def _words(text: str) -> set[str]:
    return {w.rstrip("s") if len(w) > 3 else w for w in re.findall(r"[a-z]+", text.lower())}


def relevant(query: str, tags: str) -> bool:
    """Does a clip's tags/description really match the search? Needs at least one meaningful
    query word (not just 'couple' or 'american') and nothing off-topic like animals."""
    q, t = _words(query), _words(tags)
    if (t & _words(" ".join(OFF_TOPIC))) and not (q & _words(" ".join(OFF_TOPIC))):
        return False
    key = q - _words(" ".join(GENERIC)) - _words(" ".join(STOP))
    return not key or bool(key & t)


def search_stock(query: str, exclude: set[str] = frozenset(), alts: list[str] = (),
                 avoid: set[str] = frozenset()) -> dict | None:
    """A fresh clip for `query` (or its alternates) from Pexels and/or Pixabay.
    `exclude`: never use (already in this video / already tried). `avoid`: used in earlier videos —
    skipped unless nothing else exists. Picks at random among the best matches, so the same words
    don't always give the same clip. Returns {id, url, link, credit} or None."""
    for allow_old in (False, True):
        skip = set(exclude) | (set() if allow_old else set(avoid))
        for q in [query, *alts]:
            for search in (_search_pexels, _search_pixabay):
                try:
                    cands = search(q, skip)
                except httpx.HTTPError as exc:
                    print(f"[broll] {search.__name__} failed: {exc}")
                    cands = []
                if cands:
                    top = cands[:8]  # best matches only, then mix it up
                    return random.choice(top)
    return None


def _search_pexels(query: str, skip: set[str]) -> list[dict]:
    if not config.PEXELS_API_KEY:
        return []
    r = httpx.get("https://api.pexels.com/v1/videos/search",
                  params={"query": query, "orientation": "portrait", "per_page": 40, "size": "medium",
                          "locale": "en-US"},
                  headers={"Authorization": config.PEXELS_API_KEY}, timeout=30)
    r.raise_for_status()
    out = []
    for video in r.json().get("videos", []):
        sid = f"pexels:{video['id']}"
        if sid in skip or video.get("duration", 0) < 2:
            continue
        if not relevant(query, video.get("url", "").replace("-", " ")):
            continue
        files = [f for f in video.get("video_files", [])
                 if f.get("file_type") == "video/mp4" and f.get("height") and f.get("width")
                 and f["height"] >= f["width"] and f["height"] >= 1280]
        if not files:
            continue
        best = min(files, key=lambda f: abs(f["height"] - 1920))
        out.append({"id": sid, "url": best["link"], "link": video.get("url", ""),
                    "credit": f'Video by {video.get("user", {}).get("name", "Pexels")} on Pexels'})
    return out


def _search_pixabay(query: str, skip: set[str]) -> list[dict]:
    """Pixabay has few vertical clips, so we take HD landscape ones too; they are
    centre-cropped to 9:16 when prepared. Vertical clips are listed first."""
    if not config.PIXABAY_API_KEY:
        return []
    r = httpx.get("https://pixabay.com/api/videos/",
                  params={"key": config.PIXABAY_API_KEY, "q": query[:100], "per_page": 80,
                          "safesearch": "true", "video_type": "film"}, timeout=30)
    r.raise_for_status()
    portrait, landscape = [], []
    for hit in r.json().get("hits", []):
        sid = f"pixabay:{hit['id']}"
        if sid in skip or hit.get("duration", 0) < 2:
            continue
        if not relevant(query, hit.get("tags", "")):
            continue
        sizes = [v for v in (hit.get("videos") or {}).values() if v.get("url") and v.get("height")]
        if not sizes:
            continue
        # After cropping to 9:16 the frame must still be sharp at 1080x1920:
        # vertical clips need ~1080 px width, landscape ones ~1440 px height.
        sharp = lambda v: v["width"] >= 1080 if v["height"] >= v["width"] else v["height"] >= 1440
        area = lambda v: v["width"] * v["height"]
        good = [v for v in sizes if sharp(v)]
        best = min(good, key=area) if good else max(sizes, key=area)
        if min(best["width"], best["height"]) < 720:
            continue
        item = {"id": sid, "url": best["url"], "link": hit.get("pageURL", ""),
                "credit": f'Video by {hit.get("user", "Pixabay")} on Pixabay'}
        (portrait if best["height"] >= best["width"] else landscape).append(item)
    return portrait + landscape  # keeps Pixabay's relevance order within each group


def prepare_clip(src: Path, dst: Path, length: float) -> None:
    """Convert a clip to a 1080x1920, 30fps, silent H.264 file of exactly `length`
    seconds (looping it if it is too short)."""
    run(["ffmpeg", "-y", "-stream_loop", "-1", "-i", str(src), "-t", f"{length:.3f}",
         "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p",
         "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", str(dst)])


def fetch_moment(moment: dict, project_dir: Path, user_clips: dict[str, Path],
                 exclude: set[str] = frozenset(), avoid: set[str] = frozenset()) -> dict | None:
    """Materialise one moment into a ready-to-render B-roll entry."""
    bdir = project_dir / "broll"
    bdir.mkdir(exist_ok=True)
    bid = uuid.uuid4().hex[:8]
    length = moment["end"] - moment["start"]
    entry = {"id": bid, "start": moment["start"], "end": moment["end"], "query": moment["query"], "alts": moment.get("alts", []),
             "removed": False, "file": f"broll/{bid}.mp4", "thumb": f"broll/{bid}.jpg"}
    if moment.get("clip_tag") and moment["clip_tag"] in user_clips:
        prepare_clip(user_clips[moment["clip_tag"]], bdir / f"{bid}.mp4", length + 0.5)
        entry.update(source="mine", credit="Your clip", query=moment["clip_tag"])
    else:
        hit = search_stock(moment["query"], exclude, moment.get("alts", []), avoid)
        if not hit:
            return None
        raw = bdir / f"{bid}_src.mp4"
        with httpx.stream("GET", hit["url"], timeout=120, follow_redirects=True) as r:
            r.raise_for_status()
            with open(raw, "wb") as fh:
                for chunk in r.iter_bytes(1 << 16):
                    fh.write(chunk)
        prepare_clip(raw, bdir / f"{bid}.mp4", length + 0.5)
        raw.unlink(missing_ok=True)
        entry.update(source="stock", stock_id=hit["id"], credit=hit["credit"], link=hit["link"])
    thumbnail(bdir / f"{bid}.mp4", bdir / f"{bid}.jpg", t=0.3, width=200)
    return entry
