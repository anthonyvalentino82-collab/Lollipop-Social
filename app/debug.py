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


def timing_facts(path: Path) -> dict | str:
    """Frame timing of the video track (timestamps only, no content): how many frames, where they
    start and end, and the biggest gaps — shows whether the picture really stops in the file."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "packet=pts_time,dts_time", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, timeout=60)
        ts, dts = [], []
        for line in out.stdout.splitlines():
            parts = (line.split(",") + ["", ""])[:2]
            try:
                ts.append(float(parts[0] or parts[1]))
            except ValueError:
                continue
            try:
                dts.append(float(parts[1]))
            except ValueError:
                pass
        if not ts:
            return {"frames": 0}
        backwards = sum(1 for x, y in zip(dts, dts[1:]) if y < x)  # decode order should never go back
        srt = sorted(ts)
        gaps = sorted(((b - a, a) for a, b in zip(srt, srt[1:])), reverse=True)[:5]
        aud = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                              "stream=duration,start_time", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, timeout=30).stdout.strip()
        return {"frames": len(ts), "first": round(srt[0], 3), "last": round(srt[-1], 3),
                "fps_measured": round(len(ts) / max(0.001, srt[-1] - srt[0]), 2),
                "out_of_order": backwards, "biggest_gaps": [[round(g, 3), round(t, 3)] for g, t in gaps],
                "audio_duration_start": aud}
    except Exception as exc:  # noqa: BLE001
        return f"timing failed: {exc}"


def freeze_facts(path: Path) -> list | str:
    """Stretches where the picture doesn't change for 1+ second."""
    import re
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path), "-an", "-vf",
                              "scale=160:-2,freezedetect=n=0.003:d=1", "-f", "null", "-"],
                             capture_output=True, text=True, timeout=300).stderr
        starts = [float(x) for x in re.findall(r"freeze_start: ([\d.]+)", out)]
        ends = [float(x) for x in re.findall(r"freeze_end: ([\d.]+)", out)]
        return [[round(a, 2), round(ends[i], 2) if i < len(ends) else "end"] for i, a in enumerate(starts)]
    except Exception as exc:  # noqa: BLE001
        return f"freeze check failed: {exc}"


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
        facts["originalTiming"] = p.get("originalTiming")
    except Exception:  # noqa: BLE001
        pass
    for name in ("source.mp4", "export.mp4"):
        if (d / name).exists():
            facts.setdefault("media", {})[name] = media_facts(d / name)
            facts.setdefault("timing", {})[name] = timing_facts(d / name)
            facts.setdefault("freezes", {})[name] = freeze_facts(d / name)
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
            "exportPreset": config.EXPORT_PRESET, **_machine()}


def _machine() -> dict:
    """CPU count the server reports vs. what it's allowed to use, and memory limit/use (cgroup)."""
    import os
    out = {"cpuReported": os.cpu_count()}
    def read(path):
        try:
            return open(path).read().strip()
        except OSError:
            return None
    cpu = read("/sys/fs/cgroup/cpu.max")
    if cpu and cpu.split()[0] != "max":
        q, per = cpu.split()
        out["cpuAllowed"] = round(int(q) / int(per), 2)
    for key, path in (("memLimitMB", "/sys/fs/cgroup/memory.max"), ("memUsedMB", "/sys/fs/cgroup/memory.current"),
                      ("memPeakMB", "/sys/fs/cgroup/memory.peak")):
        v = read(path)
        if v and v.isdigit():
            out[key] = int(v) // 2**20
    return out


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


def list_projects(limit: int = 10) -> list[dict]:
    dirs = sorted((d for d in config.PROJECTS_DIR.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime, reverse=True)
    out = []
    for d in dirs[:limit]:
        try:
            p = json.loads((d / "project.json").read_text())
        except Exception:  # noqa: BLE001
            continue
        out.append({"id": d.name, "created": p.get("created"), "status": p.get("status"),
                    "source": p.get("source"), "autoEdited": p.get("autoEdited"),
                    "files": sorted(f.name for f in d.iterdir() if f.is_file())})
    return out


def list_reports() -> list[dict]:
    out = []
    for f in sorted(config.REPORTS_DIR.glob("*.json"), reverse=True):
        try:
            r = json.loads(f.read_text())
            out.append({"id": r["id"], "time": r["time"], "note": r.get("note"), "projectId": r.get("projectId")})
        except Exception:  # noqa: BLE001
            continue
    return out
