"""Project storage (one folder + project.json per video) and the processing steps."""
import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from . import config
from .pipeline import audio as audio_mod
from .pipeline import broll as broll_mod
from .pipeline import media
from .pipeline.render import render_project
from .pipeline.timeline import build_caption_lines
from .pipeline.transcribe import transcribe
from .pipeline.vision import face_track
from .pipeline.zoom import plan_zooms

_lock = threading.Lock()

BUILTIN_LOGOS = [{"id": "lollipop", "name": "LolliPOP", "url": "/static/brand/lollipop-logo.png", "builtin": True}]

DEFAULT_SETTINGS = {
    "logos": [],
    "defaultLogo": "lollipop",
    "logoDefaults": {"x": 0.5, "y": 0.075, "w": 0.42, "opacity": 1.0},
    "captionDefaults": {"font": "Montserrat", "size": 66, "color": "#FFFFFF", "highlight": "#F2C230",
                        "stroke": 7, "strokeColor": "#000000", "uppercase": True, "animation": "pop",
                        "x": 0.5, "y": 0.72, "maxWords": 3},
    "headlineDefaults": {"font": "Anton", "size": 130, "color": "#E9E1D3", "accent": "#D7262E",
                         "uppercase": True, "lineHeight": 0.95, "maxWidth": 0.92,
                         "x": 0.5, "y": 0.27, "behind": True},
    "zoomDefaults": {"intensity": "medium"},
}


# ---------- settings ----------

def _settings_path() -> Path:
    return config.DATA_DIR / "settings.json"


def load_settings() -> dict:
    s = json.loads(json.dumps(DEFAULT_SETTINGS))
    if _settings_path().exists():
        saved = json.loads(_settings_path().read_text())
        for k, v in saved.items():
            if isinstance(v, dict) and isinstance(s.get(k), dict):
                s[k].update(v)
            else:
                s[k] = v
    return s


def save_settings(patch: dict) -> dict:
    with _lock:
        s = load_settings()
        for k, v in patch.items():
            if k not in DEFAULT_SETTINGS:
                continue
            if isinstance(v, dict) and isinstance(s.get(k), dict):
                s[k].update(v)
            else:
                s[k] = v
        _settings_path().write_text(json.dumps(s, indent=2))
        return s


def all_logos(settings: dict) -> list[dict]:
    return BUILTIN_LOGOS + [{**l, "url": f"/files/logos/{l['file']}"} for l in settings.get("logos", [])]


def logo_path(logo_id: str) -> Path | None:
    if logo_id == "lollipop":
        return config.STATIC_DIR / "brand" / "lollipop-logo.png"
    for l in load_settings().get("logos", []):
        if l["id"] == logo_id:
            return config.LOGOS_DIR / l["file"]
    return None


# ---------- user b-roll clips ----------

def _clips_index() -> Path:
    return config.CLIPS_DIR / "clips.json"


def list_clips() -> list[dict]:
    if not _clips_index().exists():
        return []
    return json.loads(_clips_index().read_text())


def save_clips(clips: list[dict]) -> None:
    _clips_index().write_text(json.dumps(clips, indent=2))


# ---------- projects ----------

def pdir(pid: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{12}", pid):
        raise FileNotFoundError(pid)
    return config.PROJECTS_DIR / pid


def load(pid: str) -> dict:
    p = pdir(pid) / "project.json"
    if not p.exists():
        raise FileNotFoundError(pid)
    return json.loads(p.read_text())


def save(project: dict) -> dict:
    project["updated"] = time.time()
    path = pdir(project["id"]) / "project.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(project))
    tmp.replace(path)
    return project


EDITABLE = {"trim", "captions", "headline", "logo", "zoom", "broll", "music", "audio"}


def update(pid: str, patch: dict) -> dict:
    with _lock:
        project = load(pid)
        for k, v in patch.items():
            if k in EDITABLE:
                project[k] = v
        return save(project)


def list_projects(limit: int = 20) -> list[dict]:
    out = []
    for d in sorted(config.PROJECTS_DIR.iterdir(), key=lambda d: d.stat().st_mtime, reverse=True):
        f = d / "project.json"
        if f.exists():
            p = json.loads(f.read_text())
            out.append({"id": p["id"], "name": p.get("name"), "created": p.get("created"),
                        "status": p.get("status"), "duration": p.get("source", {}).get("duration")})
        if len(out) >= limit:
            break
    return out


def cleanup_old(days: int = 14) -> None:
    cutoff = time.time() - days * 86400
    for d in config.PROJECTS_DIR.iterdir():
        if d.is_dir() and d.stat().st_mtime < cutoff:
            shutil.rmtree(d, ignore_errors=True)


def create(upload_name: str) -> tuple[dict, Path]:
    pid = uuid.uuid4().hex[:12]
    d = config.PROJECTS_DIR / pid
    d.mkdir(parents=True)
    ext = Path(upload_name or "video.mov").suffix.lower() or ".mov"
    s = load_settings()
    project = {
        "id": pid, "name": Path(upload_name or "Video").stem[:60], "created": time.time(),
        "status": "uploading", "source": {}, "trim": {"start": 0, "end": 0},
        "words": [],
        "captions": {"enabled": True, "style": dict(s["captionDefaults"]), "lines": []},
        "headline": {"enabled": False, "text": "", **s["headlineDefaults"]},
        "logo": {"enabled": True, "id": s["defaultLogo"], **s["logoDefaults"]},
        "zoom": {"enabled": True, "intensity": s["zoomDefaults"]["intensity"], "segments": []},
        "faceTrack": [],
        "broll": [],
        "music": {"enabled": False, "file": None, "name": None, "volume": 0.25, "duck": True},
        "audio": {"clean": True},
        "autoEdited": False, "warnings": [],
    }
    save(project)
    return project, d / f"original{ext}"


def prepare(pid: str, progress) -> dict:
    """Make a clean H.264 working copy that plays in Safari and is easy to process."""
    d = pdir(pid)
    original = next(d.glob("original.*"))
    progress(0.05, "Reading video")
    info = media.probe(original)
    if info["duration"] > 600:
        raise RuntimeError("Please use a video shorter than 10 minutes.")
    progress(0.15, "Optimizing video")
    media.normalize(original, d / "source.mp4", info)
    info2 = media.probe(d / "source.mp4")
    media.thumbnail(d / "source.mp4", d / "thumb.jpg", t=min(1.0, info2["duration"] / 2))
    original.unlink(missing_ok=True)  # save disk space; the working copy is all we need
    with _lock:
        p = load(pid)
        p["source"] = {k: info2[k] for k in ("width", "height", "fps", "duration")}
        p["trim"] = {"start": 0, "end": round(info2["duration"], 3)}
        p["status"] = "ready"
        save(p)
    return {"ok": True}


def auto_edit(pid: str, progress) -> dict:
    d = pdir(pid)
    p = load(pid)
    src = d / "source.mp4"
    warnings = []

    progress(0.05, "Cleaning up your voice")
    audio_mod.clean_voice(src, d / "voice_clean.wav")
    media.extract_wav(d / "voice_clean.wav", d / "voice16k.wav")

    progress(0.2, "Transcribing captions")
    try:
        words = transcribe(d / "voice_clean.wav", d)
    except Exception as exc:
        words = []
        warnings.append(f"Captions: transcription failed ({exc})")

    style = p["captions"]["style"]
    lines = build_caption_lines(words, int(style.get("maxWords", 3)))

    progress(0.45, "Finding your face")
    track = face_track(src, p["source"]["width"], p["source"]["height"], p["source"]["duration"])
    if not track:
        warnings.append("Zoom: no face found, so zooms stay centered.")

    progress(0.6, "Planning zooms")
    segments = []
    if words:
        energy = audio_mod.word_energy(d / "voice16k.wav", words)
        segments = plan_zooms(words, energy, p["zoom"].get("intensity", "medium"))

    progress(0.65, "Choosing B-roll")
    broll = []
    clips = {c["tag"]: config.CLIPS_DIR / c["file"] for c in list_clips()}
    if not config.PEXELS_API_KEY and not clips:
        warnings.append("B-roll: add a PEXELS_API_KEY or upload your own clips to enable it.")
    elif lines:
        trimmed = [l for l in lines if l["start"] >= p["trim"]["start"] and l["end"] <= p["trim"]["end"]]
        moments, method = broll_mod.plan_moments(trimmed, p["trim"]["end"] - p["trim"]["start"], list(clips))
        used: set[int] = set()
        for k, m in enumerate(moments):
            progress(0.7 + 0.25 * k / max(1, len(moments)), f"Downloading B-roll: {m['query']}")
            try:
                if m.get("clip_tag") and m["clip_tag"] not in clips:
                    m["clip_tag"] = ""
                if not m.get("clip_tag") and not config.PEXELS_API_KEY:
                    continue
                entry = broll_mod.fetch_moment(m, d, clips, used)
                if entry:
                    entry["method"] = method
                    used.add(entry.get("pexels_id", -1))
                    broll.append(entry)
            except Exception as exc:
                warnings.append(f"B-roll '{m['query']}' failed: {exc}")

    with _lock:
        p = load(pid)
        for old in p.get("broll", []):  # drop files from a previous auto edit
            for key in ("file", "thumb"):
                (d / old.get(key, "_none_")).unlink(missing_ok=True)
        p["words"] = words
        p["captions"]["lines"] = lines
        p["faceTrack"] = track
        p["zoom"]["segments"] = segments
        p["broll"] = broll
        p["autoEdited"] = True
        p["warnings"] = warnings
        save(p)
    return {"warnings": warnings}


def swap_broll(pid: str, bid: str, progress) -> dict:
    """Replace one B-roll clip with the next-best Pexels result."""
    d = pdir(pid)
    p = load(pid)
    b = next(x for x in p["broll"] if x["id"] == bid)
    progress(0.2, f"Finding another clip for “{b['query']}”")
    exclude = set(b.get("tried", [])) | {b.get("pexels_id", -1)}
    entry = broll_mod.fetch_moment({"start": b["start"], "end": b["end"], "query": b["query"]},
                                   d, {}, exclude)
    if not entry:
        raise RuntimeError("No other clips found for that topic.")
    entry["tried"] = sorted(exclude | {entry.get("pexels_id", -1)})
    with _lock:
        p = load(pid)
        p["broll"] = [entry if x["id"] == bid else x for x in p["broll"]]
        save(p)
    for key in ("file", "thumb"):
        (d / b[key]).unlink(missing_ok=True)
    return {"broll": entry}


def render(pid: str, progress) -> dict:
    d = pdir(pid)
    p = load(pid)
    music = d / p["music"]["file"] if p["music"].get("file") else None
    out_tmp = d / "export_tmp.mp4"
    render_project(p, d, out_tmp, logo_path(p["logo"].get("id", "lollipop")), music, progress)
    out_tmp.replace(d / "export.mp4")
    return {"url": f"/files/projects/{pid}/export.mp4?v={int(time.time())}"}
