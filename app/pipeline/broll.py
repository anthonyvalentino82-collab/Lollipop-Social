"""Auto B-roll: choose moments from the transcript, then fetch matching footage
from your own uploaded clips or from Pexels / Pixabay (free, licensed for commercial use)."""
import json
import re
import uuid
from pathlib import Path

import httpx

from .. import config
from .media import run, thumbnail

STOP = set("""a an the and or but so to of in on at for is are was were be been being it its i me my you your
we our they them their he she his her this that these those with from as by not no yes just really very
can could would should will do does did done have has had get got going go gonna want know think like
about what when where who why how all any some more most than then there here now well also because
into out up down over again only one two make made thing things way lot right okay yeah""".split())


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
        "playing). Choose concrete, visual ideas (e.g. 'house keys', 'family moving in', 'city skyline'), "
        "never abstract words.\n\n"
        f"Rules: at most {max_moments} moments; skip the first 2 seconds (viewers need to see the "
        "speaker's face first); each moment spans 1-3 consecutive caption lines (about 2-4 seconds); "
        "leave at least 4 seconds between moments; B-roll should cover under a third of the video.\n"
        "`query` is a 1-3 word stock-footage search term. "
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
                           "query": {"type": "string"}, "clip_tag": {"type": "string"}},
            "required": ["first_line", "last_line", "query", "clip_tag"],
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
        out.append({"start": start, "end": end, "query": m["query"].strip()[:60], "clip_tag": tag})
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
        keywords = [w for w in words if len(w) >= 4 and w not in STOP]
        if tag or keywords:
            candidates.append((i, tag, max(keywords, key=len) if keywords else tag))
    want = max(1, min(5, round(duration / 12)))
    if not candidates:
        return []
    step = max(1, len(candidates) // want)
    out = []
    for i, tag, kw in candidates[step // 2::step][:want]:
        start, end = _window(lines, i, i + 1)
        out.append({"start": start, "end": end, "query": kw, "clip_tag": tag})
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


def search_stock(query: str, exclude: set[str] = frozenset()) -> dict | None:
    """Best clip for `query` from Pexels and/or Pixabay (whichever keys are set).
    Returns {id, url, link, credit} or None. Ids look like "pexels:123" / "pixabay:456"."""
    for search in (_search_pexels, _search_pixabay):
        try:
            hit = search(query, exclude)
        except httpx.HTTPError as exc:
            print(f"[broll] {search.__name__} failed: {exc}")
            hit = None
        if hit:
            return hit
    return None


def _search_pexels(query: str, exclude: set[str]) -> dict | None:
    if not config.PEXELS_API_KEY:
        return None
    r = httpx.get("https://api.pexels.com/v1/videos/search",
                  params={"query": query, "orientation": "portrait", "per_page": 10, "size": "medium"},
                  headers={"Authorization": config.PEXELS_API_KEY}, timeout=30)
    r.raise_for_status()
    for video in r.json().get("videos", []):
        sid = f"pexels:{video['id']}"
        if sid in exclude or video.get("duration", 0) < 2:
            continue
        files = [f for f in video.get("video_files", [])
                 if f.get("file_type") == "video/mp4" and f.get("height") and f.get("width")
                 and f["height"] >= f["width"] and f["height"] >= 1280]
        if not files:
            continue
        best = min(files, key=lambda f: abs(f["height"] - 1920))
        return {"id": sid, "url": best["link"], "link": video.get("url", ""),
                "credit": f'Video by {video.get("user", {}).get("name", "Pexels")} on Pexels'}
    return None


def _search_pixabay(query: str, exclude: set[str]) -> dict | None:
    """Pixabay has few vertical clips, so we take HD landscape ones too; they are
    centre-cropped to 9:16 when prepared."""
    if not config.PIXABAY_API_KEY:
        return None
    r = httpx.get("https://pixabay.com/api/videos/",
                  params={"key": config.PIXABAY_API_KEY, "q": query[:100], "per_page": 20,
                          "safesearch": "true", "video_type": "film"}, timeout=30)
    r.raise_for_status()
    candidates = []
    for hit in r.json().get("hits", []):
        sid = f"pixabay:{hit['id']}"
        if sid in exclude or hit.get("duration", 0) < 2:
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
        portrait = best["height"] >= best["width"]
        candidates.append((0 if portrait else 1, {
            "id": sid, "url": best["url"], "link": hit.get("pageURL", ""),
            "credit": f'Video by {hit.get("user", "Pixabay")} on Pixabay'}))
    if not candidates:
        return None
    return min(candidates, key=lambda c: c[0])[1]  # prefer vertical, keep Pixabay's relevance order


def prepare_clip(src: Path, dst: Path, length: float) -> None:
    """Convert a clip to a 1080x1920, 30fps, silent H.264 file of exactly `length`
    seconds (looping it if it is too short)."""
    run(["ffmpeg", "-y", "-stream_loop", "-1", "-i", str(src), "-t", f"{length:.3f}",
         "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p",
         "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", str(dst)])


def fetch_moment(moment: dict, project_dir: Path, user_clips: dict[str, Path],
                 exclude: set[str] = frozenset()) -> dict | None:
    """Materialise one moment into a ready-to-render B-roll entry."""
    bdir = project_dir / "broll"
    bdir.mkdir(exist_ok=True)
    bid = uuid.uuid4().hex[:8]
    length = moment["end"] - moment["start"]
    entry = {"id": bid, "start": moment["start"], "end": moment["end"], "query": moment["query"],
             "removed": False, "file": f"broll/{bid}.mp4", "thumb": f"broll/{bid}.jpg"}
    if moment.get("clip_tag") and moment["clip_tag"] in user_clips:
        prepare_clip(user_clips[moment["clip_tag"]], bdir / f"{bid}.mp4", length + 0.5)
        entry.update(source="mine", credit="Your clip", query=moment["clip_tag"])
    else:
        hit = search_stock(moment["query"], exclude)
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
