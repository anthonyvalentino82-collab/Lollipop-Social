"""Thin wrappers around ffmpeg / ffprobe."""
import json
import subprocess
from pathlib import Path


class MediaError(RuntimeError):
    pass


def run(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-15:])
        raise MediaError(f"{cmd[0]} failed:\n{tail}")
    return proc.stdout


def run_with_progress(cmd: list[str], duration: float, on_progress) -> None:
    """Run an ffmpeg command, reporting 0..1 progress as it encodes."""
    cmd = cmd[:1] + ["-progress", "pipe:1", "-nostats"] + cmd[1:]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    import threading
    err: list[str] = []
    t = threading.Thread(target=lambda: err.extend(proc.stderr.readlines()), daemon=True)
    t.start()
    for line in proc.stdout:
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                secs = int(line.split("=", 1)[1]) / 1_000_000
            except ValueError:
                continue
            if duration > 0:
                on_progress(min(1.0, max(0.0, secs / duration)))
    proc.wait()
    t.join(timeout=5)
    if proc.returncode != 0:
        tail = "".join(err[-15:]).strip()
        raise MediaError(f"{cmd[0]} failed:\n{tail}")


def probe(path: Path) -> dict:
    out = run(["ffprobe", "-v", "error", "-print_format", "json",
               "-show_format", "-show_streams", str(path)])
    info = json.loads(out)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    if v is None:
        raise MediaError("That file has no video track.")
    w, h = int(v["width"]), int(v["height"])
    rotation = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(float(sd["rotation"]))
    if "rotate" in v.get("tags", {}):
        rotation = int(v["tags"]["rotate"])
    if abs(rotation) % 180 == 90:
        w, h = h, w
    num, den = (v.get("avg_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den) if float(den) else 30.0
    duration = float(info["format"].get("duration") or v.get("duration") or 0)
    return {
        "width": w, "height": h, "fps": fps, "duration": duration,
        "has_audio": a is not None,
        "color_transfer": v.get("color_transfer", ""),
    }


def has_filter(name: str) -> bool:
    try:
        return f" {name} " in run(["ffmpeg", "-hide_banner", "-filters"])
    except MediaError:
        return False


def normalize(src: Path, dst: Path, info: dict, on_progress=lambda f: None) -> None:
    """Convert any phone video (HEVC, HDR, rotated, 4K, 60fps) into an H.264
    30fps working copy whose short side is at most 1080px."""
    if info["width"] <= info["height"]:
        scale = "scale='min(1080,iw)':-2"
    else:
        scale = "scale=-2:'min(1080,ih)'"
    # Drop frames and shrink first: everything after runs on 4x fewer pixels.
    vf = ["fps=30", scale]
    # iPhone records HDR (HLG / Dolby Vision) by default; tone-map it to normal SDR.
    if info.get("color_transfer") in ("arib-std-b67", "smpte2084") and has_filter("zscale"):
        vf += ["zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709",
               "tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=tv"]
    vf.append("format=yuv420p")
    cmd = ["ffmpeg", "-y", "-i", str(src), "-vf", ",".join(vf),
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
           "-movflags", "+faststart"]
    if info["has_audio"]:
        cmd += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
    else:
        # Add a silent track so the rest of the pipeline can assume audio exists.
        cmd = cmd[:3] + ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"] + cmd[3:] + [
            "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-shortest"]
    cmd.append(str(dst))
    run_with_progress(cmd, info.get("duration", 0), on_progress)


def extract_wav(src: Path, dst: Path, rate: int = 16000) -> None:
    run(["ffmpeg", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", str(rate), str(dst)])


def thumbnail(src: Path, dst: Path, t: float = 0.5, width: int = 240) -> None:
    run(["ffmpeg", "-y", "-ss", str(t), "-i", str(src), "-frames:v", "1",
         "-vf", f"scale={width}:-2", "-q:v", "4", str(dst)])
