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


def count_for(duration: float) -> int:
    """How many B-roll clips the one-tap AI edit uses: 1 for a ~15 s reel, 2 for ~30 s, 3 for ~60 s."""
    return 1 if duration <= 20 else 2 if duration <= 45 else 3


def plan_moments(lines: list[dict], duration: float, clip_tags: list[str],
                 want: int | None = None) -> tuple[list[dict], str]:
    """Returns (moments, method). Each moment: {start, end, query, clip_tag}.
    `want`: exact number of moments to aim for (None = decide from the length)."""
    if not lines:
        return [], "none"
    if config.ANTHROPIC_API_KEY:
        try:
            return _plan_with_claude(lines, duration, clip_tags, want), "claude"
        except Exception as exc:  # fall back rather than failing the whole auto edit
            print(f"[broll] Claude planning failed, using keyword fallback: {exc}")
    return _plan_with_keywords(lines, duration, clip_tags, want), "keywords"


def plan_chosen(lines: list[dict], items: list[dict]) -> list[dict]:
    """The creator chose the B-roll (typed search words and/or their own clips): spread them
    evenly through the video, after the first 2 seconds."""
    usable = [i for i, ln in enumerate(lines) if ln["start"] >= 2.0]
    if not usable or not items:
        return []
    t0, t1 = lines[usable[0]]["start"], lines[-1]["end"]
    out, taken = [], set()
    for k, item in enumerate(items):
        target = t0 + (t1 - t0) * (k + 0.5) / len(items)
        i = min((j for j in usable if j not in taken), key=lambda j: abs(lines[j]["start"] - target), default=None)
        if i is None:
            break
        taken.update({i, i + 1})
        start, end = _window(lines, i, i + 1)
        if item.get("clip_tag"):
            out.append({"start": start, "end": end, "query": item["clip_tag"], "clip_tag": item["clip_tag"]})
        else:
            q = item.get("query", "").strip()[:60]
            # The creator typed these words: the clip must show them (not what's being said).
            out.append({"start": start, "end": end, "query": q, "clip_tag": "", "text": q, "alts": []})
    return _non_overlapping(sorted(out, key=lambda m: m["start"]))


def _text(lines, a, b) -> str:
    """What the speaker says over caption lines a..b (what the B-roll must show)."""
    a, b = max(0, min(a, b, len(lines) - 1)), min(len(lines) - 1, max(a, b))
    return " ".join(w["w"] for ln in lines[a:b + 1] for w in ln["words"])[:300]


def _window(lines, a, b):
    a, b = max(0, min(a, len(lines) - 1)), max(0, min(b, len(lines) - 1))
    a, b = min(a, b), max(a, b)
    start, end = lines[a]["start"], lines[b]["end"]
    if end - start < 1.8:
        end = start + 1.8
    return round(start, 3), round(min(end, start + 4.5), 3)


def _plan_with_claude(lines, duration, clip_tags, want=None):
    import anthropic

    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    transcript = "\n".join(f'{i}: [{ln["start"]:.1f}s] {" ".join(w["w"] for w in ln["words"])}'
                           for i, ln in enumerate(lines))
    max_moments = want or max(1, min(6, round(duration / 10)))
    prompt = (
        "You are editing a short vertical talking-head video for social media. Pick moments where "
        "cutting away to B-roll footage would illustrate what the speaker is saying (the voice keeps "
        "playing). The footage must show EXACTLY what those words are about: a viewer should see the "
        "clip and think 'yes, that's what they're talking about'. Pick the moments with the most "
        "obvious, picturable idea, and write the search for that exact idea, never a general topic.\n\n"
        f"The creator makes videos about {config.BROLL_NICHE} for an American audience. When the "
        "words are about that world, search for clear, polished U.S.-looking footage of it: American "
        "suburban homes and neighborhoods, a dream home exterior, 'for sale' yard signs, a real estate "
        "agent showing a house, homebuyers signing at a closing table, handing over house keys, a "
        "family moving into a new home, grandparents with grandchildren at home (generational "
        "wealth, legacy), saving money / a piggy bank, counting U.S. dollar bills, a stock market "
        "chart, a calculator with bills, etc. Add 'american' or 'suburban' when it helps.\n"
        "Describing words mean what they say: if the speaker says something is beautiful, stunning, "
        "peaceful or amazing, the clip must look that way — a golden sunset, a mountain landscape, "
        "an ocean view, a gorgeous luxury home with a pool — not an ordinary street or city. "
        "Search for the beauty itself (e.g. 'golden sunset mountains', 'luxury home pool sunset').\n"
        "Avoid abstract, generic, cheesy or foreign-looking scenes, and avoid words with other meanings "
        "(say 'homebuyers', not just 'couple', which also finds animals).\n\n"
        + (f"Rules: exactly {max_moments} moment{'s' if max_moments > 1 else ''} (spread through the video); skip"
         if want else f"Rules: at most {max_moments} moments; skip") + " the first 2 seconds (viewers need to see the "
        "speaker's face first); each moment spans 1-3 consecutive caption lines (about 2-4 seconds); "
        "leave at least 4 seconds between moments; B-roll should cover under a third of the video.\n"
        "`query` is a 2-4 word stock-footage search term; `alts` are 2 different search terms for the "
        "same idea (other ways to film it), used when the first finds nothing good. "
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
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
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
                    "text": _text(lines, m["first_line"], m["last_line"]),
                    "alts": [a.strip()[:60] for a in m.get("alts", []) if a.strip()][:3]})
    return _non_overlapping(out)


def _plan_with_keywords(lines, duration, clip_tags, want=None):
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
    want = want or max(1, min(5, round(duration / 12)))
    if not candidates:
        return []
    step = max(1, len(candidates) // want)
    out = []
    for i, tag, kw in candidates[step // 2::step][:want]:
        start, end = _window(lines, i, i + 1)
        out.append({"start": start, "end": end, "query": kw, "clip_tag": tag, "text": _text(lines, i, i + 1),
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


# On-topic extra searches for the keyword fallback (only used when the AI planner is unavailable).
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
video footage background view modern beautiful stunning gorgeous amazing scenic pretty nice""".split())
# Never show these unless the search itself asks for them.
OFF_TOPIC = set("""animal animals bird birds duck ducks dog dogs cat cats wildlife insect insects fish horse horses cow
cows chicken chickens butterfly bee bees pet pets zoo jungle safari""".split())
# Not real footage (drawn, 3D, AI-made) — looks fake next to a real person talking.
FAKE = set("""animation animated cartoon illustration illustrated render rendering rendered 3d cgi anime drawing
painting painted fantasy fairytale magic magical surreal generated artificial wallpaper lofi loop seamless
abstract particles neon hologram""".split())


def _words(text: str) -> set[str]:
    return {w.rstrip("s") if len(w) > 3 else w for w in re.findall(r"[a-z]+", text.lower())}


def relevant(query: str, tags: str, strict: bool = True) -> bool:
    """Does a clip's tags/description really match the search? Needs meaningful query words
    (not just 'couple' or 'american') and nothing off-topic like animals. `strict` (no AI to look
    at the picture): two matching words; otherwise one, and the AI checks the picture."""
    q, t = _words(query), _words(tags)
    if (t & _words(" ".join(OFF_TOPIC))) and not (q & _words(" ".join(OFF_TOPIC))):
        return False
    if t & _words(" ".join(FAKE)):
        return False
    key = q - _words(" ".join(GENERIC)) - _words(" ".join(STOP))
    # "suburban home" must match both words, not just "home" (a cartoon winter room is a "home" too).
    return not key or len(key & t) >= (min(2, len(key)) if strict else 1)


def search_stock(query: str, exclude: set[str] = frozenset(), alts: list[str] = (),
                 avoid: set[str] = frozenset(), text: str = "") -> dict | None:
    """The best clip for `query` (or its alternates) from Pexels and/or Pixabay.
    `exclude`: never use (already in this video / already tried). `avoid`: used in earlier videos —
    only when nothing fresh fits. `text`: what the speaker says there.

    With an Anthropic key the AI LOOKS at a still of each candidate next to the spoken words and
    picks the one that really shows it (or none, then tries one better search of its own). No
    random "general topic" fallback any more: no good match = the speaker stays on screen.
    Returns {id, url, link, credit} or None."""
    queries = [q for q in dict.fromkeys([query, *alts]) if q and q.strip()]
    if not config.ANTHROPIC_API_KEY:  # no AI to look: best text match, fresh first
        for skip in (set(exclude) | set(avoid), set(exclude)):
            for q in queries:
                cands = _gather([q], skip, strict=True)
                if cands:
                    return random.choice(cands[:8])
        return None
    for attempt in range(2):
        fresh = _gather(queries, set(exclude) | set(avoid))
        old = _gather(queries, set(exclude), limit=4, only=set(avoid)) if len(fresh) < 6 else []
        cands = (fresh[:10] + old)[:12]
        if cands:
            pick, retry = judge(text or query, query, cands)
            if pick is not None:
                return cands[pick]
        else:
            retry = ""
        if not retry or attempt:
            return None
        queries = [retry.strip()[:60]]
    return None


def _gather(queries, skip, limit=10, strict=False, only=None):
    """Candidates from both sites for the searches, best first, no duplicates. `only`: just these ids."""
    out, seen = [], set()
    for q in queries:
        for search in (_search_pexels, _search_pixabay):
            try:
                cands = search(q, skip, strict)
            except httpx.HTTPError as exc:
                print(f"[broll] {search.__name__} failed: {exc}")
                cands = []
            for c in cands[:5]:
                if c["id"] in seen or (only is not None and c["id"] not in only):
                    continue
                seen.add(c["id"])
                out.append({**c, "old": only is not None})
            if len(out) >= limit:
                return out[:limit]
    return out


def _thumb_b64(url: str) -> str | None:
    """A small JPEG of a clip's preview frame (base64), or None."""
    import base64
    import io
    from PIL import Image
    try:
        r = httpx.get(url, timeout=15, follow_redirects=True)
        r.raise_for_status()
        im = Image.open(io.BytesIO(r.content)).convert("RGB")
        im.thumbnail((384, 384))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=80)
        return base64.b64encode(buf.getvalue()).decode()
    except Exception as exc:  # a missing preview just drops that candidate
        print(f"[broll] preview {url[:80]} failed: {exc}")
        return None


def judge(text: str, query: str, cands: list[dict]) -> tuple[int | None, str]:
    """Show the AI a still of every candidate and what the speaker says; it picks the clip that
    really shows it. Returns (index into cands or None, a better search to try or "")."""
    from concurrent.futures import ThreadPoolExecutor

    import anthropic

    with ThreadPoolExecutor(6) as ex:
        thumbs = list(ex.map(lambda c: _thumb_b64(c["thumb"]) if c.get("thumb") else None, cands))
    shown = [i for i, t in enumerate(thumbs) if t]
    if not shown:
        return None, ""
    content = [{"type": "text", "text": (
        f"B-roll for a vertical social video about {config.BROLL_NICHE} (American audience). "
        f"While this clip plays, the speaker says: \"{text}\" (search used: \"{query}\").\n"
        "Below are stills from candidate stock clips. Pick the ONE that most clearly and literally "
        "shows what is being said, looks real (not animated), polished and American, with no big "
        "visible text, logos or watermarks. If the words describe something as beautiful, stunning or "
        "peaceful, the clip must look truly beautiful (golden light, mountains, ocean, a gorgeous "
        "home), not an ordinary street or city. Clips marked 'used before' appeared in the creator's "
        "earlier videos: choose one only if nothing else fits. If none clearly fits, answer -1 and "
        "give a better 2-4 word stock-footage search in retry_query (else an empty string).")}]
    for k, i in enumerate(shown):
        content.append({"type": "text", "text": f"Clip {k}{' (used before)' if cands[i].get('old') else ''}:"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": thumbs[i]}})
    schema = {"type": "object", "properties": {"pick": {"type": "integer"}, "retry_query": {"type": "string"}},
              "required": ["pick", "retry_query"], "additionalProperties": False}
    try:
        client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
        resp = client.messages.create(
            model=config.CLAUDE_MODEL, max_tokens=1000,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": content}])
        data = json.loads(next(b.text for b in resp.content if b.type == "text"))
    except Exception as exc:  # the AI couldn't look: fall back to the best text match
        print(f"[broll] judge failed: {exc}")
        return shown[0], ""
    k = data.get("pick", -1)
    if isinstance(k, int) and 0 <= k < len(shown):
        return shown[k], ""
    return None, (data.get("retry_query") or "").strip()


def _search_pexels(query: str, skip: set[str], strict: bool = False) -> list[dict]:
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
        if not relevant(query, video.get("url", "").replace("-", " "), strict):
            continue
        files = [f for f in video.get("video_files", [])
                 if f.get("file_type") == "video/mp4" and f.get("height") and f.get("width")
                 and f["height"] >= f["width"] and f["height"] >= 1280]
        if not files:
            continue
        best = min(files, key=lambda f: abs(f["height"] - 1920))
        pics = video.get("video_pictures") or []
        thumb = (pics[len(pics) // 2].get("picture") if pics else None) or video.get("image")
        out.append({"id": sid, "url": best["link"], "link": video.get("url", ""), "thumb": thumb,
                    "credit": f'Video by {video.get("user", {}).get("name", "Pexels")} on Pexels'})
    return out


def _search_pixabay(query: str, skip: set[str], strict: bool = False) -> list[dict]:
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
        if not relevant(query, hit.get("tags", ""), strict):
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
        thumb = next((v.get("thumbnail") for v in (hit.get("videos") or {}).values() if v.get("thumbnail")), None)
        if not thumb and hit.get("picture_id"):
            thumb = f"https://i.vimeocdn.com/video/{hit['picture_id']}_640x360.jpg"
        item = {"id": sid, "url": best["url"], "link": hit.get("pageURL", ""), "thumb": thumb,
                "credit": f'Video by {hit.get("user", "Pixabay")} on Pixabay'}
        (portrait if best["height"] >= best["width"] else landscape).append(item)
    return portrait + landscape  # keeps Pixabay's relevance order within each group


def prepare_clip(src: Path, dst: Path, length: float) -> None:
    """Convert a clip to a 1080x1920, 30fps, silent H.264 file of exactly `length`
    seconds (looping it if it is too short)."""
    run(["ffmpeg", "-y", "-stream_loop", "-1", "-i", str(src), "-t", f"{length:.3f}",
         "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p",
         "-an", "-c:v", "libx264", "-preset", "veryfast", "-threads", config.FFMPEG_THREADS, "-crf", "20", "-movflags", "+faststart", str(dst)])


def fetch_moment(moment: dict, project_dir: Path, user_clips: dict[str, Path],
                 exclude: set[str] = frozenset(), avoid: set[str] = frozenset()) -> dict | None:
    """Materialise one moment into a ready-to-render B-roll entry."""
    bdir = project_dir / "broll"
    bdir.mkdir(exist_ok=True)
    bid = uuid.uuid4().hex[:8]
    length = moment["end"] - moment["start"]
    entry = {"id": bid, "start": moment["start"], "end": moment["end"], "query": moment["query"], "alts": moment.get("alts", []),
             "text": moment.get("text", ""),
             "removed": False, "file": f"broll/{bid}.mp4", "thumb": f"broll/{bid}.jpg"}
    if moment.get("clip_tag") and moment["clip_tag"] in user_clips:
        prepare_clip(user_clips[moment["clip_tag"]], bdir / f"{bid}.mp4", length + 0.5)
        entry.update(source="mine", credit="Your clip", query=moment["clip_tag"])
    else:
        hit = search_stock(moment["query"], exclude, moment.get("alts", []), avoid, moment.get("text", ""))
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
