"""Thin wrappers around ffmpeg / ffprobe."""
import json
import shutil
import subprocess
from pathlib import Path

from .. import config


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
    cmd = ["ffmpeg", "-y", "-threads", config.FFMPEG_THREADS, "-i", str(src), "-vf", ",".join(vf),
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", "-threads", config.FFMPEG_THREADS,
           "-movflags", "+faststart"]
    if info["has_audio"]:
        # async resampling fills tiny timestamp gaps (common in browser recordings) instead of
        # leaving dropouts, and keeps the sound in sync with the picture.
        cmd += ["-af", "aresample=async=1000:first_pts=0",
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
    else:
        # Add a silent track so the rest of the pipeline can assume audio exists.
        cmd = cmd[:3] + ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"] + cmd[3:] + [
            "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-shortest"]
    cmd.append(str(dst))
    run_with_progress(cmd, info.get("duration", 0), on_progress)


def extract_wav(src: Path, dst: Path, rate: int = 16000) -> None:
    run(["ffmpeg", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", str(rate), str(dst)])


def filmstrip(src: Path, dst: Path, duration: float, count: int = 10, w: int = 72, h: int = 128) -> None:
    """One wide JPEG of `count` evenly spaced 9:16 thumbnails, for the trim bar.
    Each frame is grabbed with a fast seek, so this takes a second or two."""
    import numpy as np
    from PIL import Image

    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"
    frames = []
    for i in range(count):
        t = duration * (i + 0.5) / count
        proc = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1",
                               "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
        buf = proc.stdout
        frames.append(np.frombuffer(buf, np.uint8).reshape(h, w, 3) if len(buf) == w * h * 3
                      else (frames[-1] if frames else np.zeros((h, w, 3), np.uint8)))
    Image.fromarray(np.hstack(frames)).save(dst, quality=80)


def frozen_at(src: Path, duration: float, min_len: float = 3.0) -> float | None:
    """If the picture freezes and stays frozen until the end (camera stopped sending frames
    while the sound kept recording), return the time it froze; otherwise None."""
    import re
    proc = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(src), "-an", "-vf",
                           f"scale=160:-2,freezedetect=n=0.002:d={min_len}", "-f", "null", "-"],
                          capture_output=True, text=True)
    starts = [float(x) for x in re.findall(r"freeze_start: ([\d.]+)", proc.stderr)]
    ends = [float(x) for x in re.findall(r"freeze_end: ([\d.]+)", proc.stderr)]
    if starts and len(ends) < len(starts) and duration - starts[-1] >= min_len:
        return starts[-1]
    return None


def thumbnail(src: Path, dst: Path, t: float = 0.5, width: int = 240) -> None:
    run(["ffmpeg", "-y", "-ss", str(t), "-i", str(src), "-frames:v", "1",
         "-vf", f"scale={width}:-2", "-q:v", "4", str(dst)])


def _pcm(src: Path, rate: int = 8000) -> "np.ndarray":
    import numpy as np
    proc = subprocess.run(["ffmpeg", "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", str(rate),
                           "-f", "s16le", "-"], capture_output=True)
    return np.frombuffer(proc.stdout, np.int16).astype(np.float32) / 32768


def _align(prev: "np.ndarray", cur: "np.ndarray", expected: float, rate: int = 8000,
           probe: float = 0.6, search: float = 0.8) -> float:
    """Where (in seconds of `prev`) does `cur` start? Matches the sound at the start of `cur`
    against `prev` around the `expected` position. Falls back to `expected` if it's unclear."""
    import numpy as np
    n = int(probe * rate)
    a = cur[:n]
    if len(a) < n or float(np.sqrt(np.mean(a ** 2))) < 0.003:
        return expected  # silence: nothing to match
    lo = max(0, int((expected - search) * rate))
    hi = min(len(prev), int((expected + search) * rate) + n)
    win = prev[lo:hi]
    if len(win) < n * 1.2:
        return expected
    a = (a - a.mean()) / (a.std() + 1e-9)
    corr = np.correlate(win - win.mean(), a, mode="valid")
    energy = np.sqrt(np.convolve((win - win.mean()) ** 2, np.ones(n), mode="valid")) + 1e-9
    score = corr / energy / np.sqrt(n)
    best = float(score.max())
    if best < 0.5:  # weak match
        return expected
    # Repetitive sound can match in several places: among near-equal matches, take the one
    # closest to where the phone said the piece started.
    cands = np.flatnonzero(score >= best * 0.9)
    k = int(cands[np.argmin(np.abs((lo + cands) / rate - expected))])
    return (lo + k) / rate


def stitch_segments(segs: list[Path], offsets: list[float], dst: Path) -> list[float]:
    """Join overlapping recording pieces (the phone restarts its recorder every few seconds)
    into one video. Each piece's real start is found by matching the overlapping sound, then the
    pieces are cut in the middle of each overlap and joined. Returns the starts used."""
    starts = [0.0]
    durs = [probe(s)["duration"] for s in segs]
    pcm_prev = _pcm(segs[0])
    for i in range(1, len(segs)):
        pcm_cur = _pcm(segs[i])
        expected = max(0.0, offsets[i] - offsets[i - 1])
        starts.append(starts[-1] + _align(pcm_prev, pcm_cur, expected))
        pcm_prev = pcm_cur
    # Cut points: middle of each overlap (or the end of the earlier piece if they don't overlap).
    cuts = []
    for i in range(1, len(segs)):
        prev_end = starts[i - 1] + durs[i - 1]
        cuts.append((starts[i] + min(prev_end, starts[i] + 1.0)) / 2 if prev_end > starts[i] else prev_end)
    # Join one piece at a time with a small, fixed number of threads. (Opening every piece at once
    # in one ffmpeg filter graph decodes them all in parallel — at full HD, on a server reporting
    # many CPU cores, that used several GB of memory and got the server restarted.)
    tmp = dst.parent / f".{dst.stem}_parts"
    tmp.mkdir(exist_ok=True)
    try:
        windows = []
        for i, s in enumerate(segs):
            g0 = 0.0 if i == 0 else cuts[i - 1]
            g1 = starts[i] + durs[i] if i == len(segs) - 1 else cuts[i]
            windows.append((max(0.0, g0 - starts[i]), max(0.01, g1 - starts[i])))
        names = []
        for i, (s, (a, b)) in enumerate(zip(segs, windows)):
            part = tmp / f"v{i}.mp4"
            run(["ffmpeg", "-y", "-threads", config.FFMPEG_THREADS, "-ss", f"{a:.3f}", "-i", str(s), "-t", f"{b - a:.3f}",
                 "-map", "0:v:0", "-an", "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast",
                 "-crf", "16", "-threads", config.FFMPEG_THREADS, str(part)])
            names.append(part)
        # Sound: cut and joined in one pass (audio is tiny; the video streams aren't decoded).
        ainputs, aparts = [], []
        for i, (s, (a, b)) in enumerate(zip(segs, windows)):
            ainputs += ["-i", str(s)]
            aparts.append(f"[{i}:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS,aresample=48000[a{i}]")
        graph = ";".join(aparts) + ";" + "".join(f"[a{i}]" for i in range(len(segs))) + f"concat=n={len(segs)}:v=0:a=1[a]"
        run(["ffmpeg", "-y", *ainputs, "-filter_complex", graph, "-map", "[a]", "-vn",
             "-c:a", "aac", "-b:a", "192k", str(tmp / "a.m4a")])
        (tmp / "list.txt").write_text("".join(f"file '{n.name}'\n" for n in names))
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(tmp / "list.txt"), "-i", str(tmp / "a.m4a"),
             "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest", "-movflags", "+faststart", str(dst)])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return starts
