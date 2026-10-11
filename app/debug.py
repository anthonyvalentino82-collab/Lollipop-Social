"""'Report a problem': the phone sends technical details of what went wrong, and Claude reads
them with the private DEBUG_KEY.

Reports hold technical facts only (phone/browser model, camera settings, error messages,
codec / frame-rate / duration of the video files). No video, audio, transcript or caption text
is ever included or downloadable. Without DEBUG_KEY set, the debug endpoints don't exist.
"""
import json
import platform
import shutil
import subprocess
import time
import uuid
from pathlib import Path

from . import config, jobs

STREAM_KEYS = ("codec_type", "codec_name", "profile", "width", "height", "pix_fmt", "color_transfer",
               "r_frame_rate", "avg_frame_rate", "duration", "nb_frames", "bit_rate", "sample_rate",
               "channels", "start_time")


def media_facts(path: Path) -> dict | str:
    """Technical facts about a video file (no content)."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format",
                              "-show_streams", str(path)], capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return out.stderr[-1000:]
        j = json.loads(out.stdout)
        fmt = j.get("format", {})
        return {"format": fmt.get("format_name"), "duration": fmt.get("duration"),
                "size": fmt.get("size"), "bit_rate": fmt.get("bit_rate"),
                "streams": [{k: s[k] for k in STREAM_KEYS if k in s} for s in j.get("streams", [])]}
    except Exception as exc:  # noqa: BLE001
        return f"ffprobe failed: {exc}"


def project_facts(pid: str) -> dict:
    d = config.PROJECTS_DIR / pid
    facts: dict = {"files": {f.name: f.stat().st_size for f in sorted(d.iterdir()) if f.is_file()}}
    try:
        p = json.loads((d / "project.json").read_text())
        facts["settings"] = {
            "status": p.get("status"), "source": p.get("source"), "trim": p.get("trim"),
            "autoEdited": p.get("autoEdited"), "removePauses": p.get("removePauses"),
            "cuts": len(p.get("cuts") or []), "pauseCuts": len(p.get("pauseCuts") or []),
            "words": len(p.get("words") or []), "broll": len(p.get("broll") or []),
            "zoomSegments": len((p.get("zoom") or {}).get("segments") or []),
            "music": {k: (p.get("music") or {}).get(k) for k in ("enabled", "volume", "autoDuck")},
            "audio": p.get("audio"), "warnings": p.get("warnings"), "sourceWarnings": p.get("sourceWarnings"),
        }
        facts["original"] = p.get("originalFacts")
    except Exception:  # noqa: BLE001
        pass
    for name in ("source.mp4", "export.mp4"):
        if (d / name).exists():
            facts.setdefault("media", {})[name] = media_facts(d / name)
    return facts


def server_info() -> dict:
    disk = shutil.disk_usage(config.DATA_DIR)
    try:
        ffv = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.splitlines()[0]
    except Exception:  # noqa: BLE001
        ffv = "?"
    return {"python": platform.python_version(), "ffmpeg": ffv,
            "diskFreeMB": disk.free // 2**20, "transcription": config.TRANSCRIBE_PROVIDER,
            "stock": config.STOCK_ENABLED, "claude": bool(config.ANTHROPIC_API_KEY),
            "exportPreset": config.EXPORT_PRESET}


def save_report(payload: dict) -> str:
    rid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    pid = str(payload.get("projectId") or "")
    report = {"id": rid, "time": time.time(), "note": str(payload.get("note") or "")[:2000],
              "client": payload.get("client") or {}, "server": server_info(),
              "jobs": [j for j in jobs.history if not pid or j.get("project") == pid][-15:]}
    if len(pid) == 12 and pid.isalnum() and (config.PROJECTS_DIR / pid).is_dir():
        report["projectId"] = pid
        report["project"] = project_facts(pid)
    (config.REPORTS_DIR / f"{rid}.json").write_text(json.dumps(report, indent=1, default=str)[:500_000])
    for old in sorted(config.REPORTS_DIR.glob("*.json"))[:-30]:  # keep the latest 30
        old.unlink(missing_ok=True)
    return rid


def list_reports() -> list[dict]:
    out = []
    for f in sorted(config.REPORTS_DIR.glob("*.json"), reverse=True):
        try:
            r = json.loads(f.read_text())
            out.append({"id": r["id"], "time": r["time"], "note": r.get("note"), "projectId": r.get("projectId")})
        except Exception:  # noqa: BLE001
            continue
    return out
