"""Final export: composites every frame and encodes a 1080x1920 H.264 MP4.

Layer order, back to front:
  1. speaker video (auto-zoomed, face-framed)  — or full-screen B-roll
  2. cinematic headline                        — drawn BEHIND the speaker using a person mask
  3. speaker cut-out                           — so the head/body covers the headline
  4. spoken captions (animated)
  5. logo
"""
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from .. import config
from . import audio as audio_mod
from .text import caption_image, headline_layer
from .timeline import broll_at, caption_at, crop_rect
from .vision import PersonSegmenter

W, H, FPS = config.OUT_W, config.OUT_H, config.OUT_FPS


def _rgba_to_np(img: Image.Image):
    """PIL RGBA -> (BGR uint8 image, float32 alpha 0..1 as HxW)."""
    a = np.asarray(img)
    rgb = np.ascontiguousarray(a[..., 2::-1])  # RGB -> BGR
    alpha = np.ascontiguousarray(a[..., 3], dtype=np.float32) / 255.0
    return rgb, alpha


def _blend(frame: np.ndarray, rgb: np.ndarray, alpha: np.ndarray, x: int, y: int) -> None:
    """Alpha-blend a BGR layer onto `frame` at (x, y), clipping at the edges."""
    h, w = alpha.shape[:2]
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    if x0 >= x1 or y0 >= y1:
        return
    sx, sy = x0 - x, y0 - y
    a = np.ascontiguousarray(alpha[sy:sy + y1 - y0, sx:sx + x1 - x0])
    c = np.ascontiguousarray(rgb[sy:sy + y1 - y0, sx:sx + x1 - x0])
    region = np.ascontiguousarray(frame[y0:y1, x0:x1])
    frame[y0:y1, x0:x1] = cv2.blendLinear(c, region, a, 1.0 - a)


class _Decoder:
    """Reads raw BGR frames from ffmpeg."""

    def __init__(self, path: Path, w: int, h: int, start: float = 0.0, duration: float | None = None,
                 vf: str | None = None):
        cmd = ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", str(path)]
        if duration:
            cmd += ["-t", f"{duration:.3f}"]
        if vf:
            cmd += ["-vf", vf]
        cmd += ["-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
        self.w, self.h = w, h
        self.size = w * h * 3
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
        self.last = None

    def read(self):
        buf = self.proc.stdout.read(self.size)
        if len(buf) == self.size:
            self.last = np.frombuffer(buf, np.uint8).reshape(self.h, self.w, 3)
        return self.last  # repeat the last frame if the stream ends a hair early

    def close(self):
        self.proc.stdout.close()
        self.proc.kill()
        self.proc.wait()


def _logo_layer(logo: dict, logo_path: Path | None):
    if not logo.get("enabled") or not logo_path or not logo_path.exists():
        return None
    img = Image.open(logo_path).convert("RGBA")
    lw = max(8, int(logo.get("w", 0.3) * W))
    lh = max(8, int(img.height * lw / img.width))
    img = img.resize((lw, lh), Image.LANCZOS)
    rgb, a = _rgba_to_np(img)
    a = a * float(logo.get("opacity", 1.0))
    return rgb, a, int(logo.get("x", 0.5) * W - lw / 2), int(logo.get("y", 0.08) * H - lh / 2)


def render_project(project: dict, pdir: Path, out: Path, logo_path: Path | None,
                   music_path: Path | None, progress=lambda p, msg: None) -> None:
    src = pdir / "source.mp4"
    info = project["source"]
    sw, sh = info["width"], info["height"]
    start = float(project["trim"]["start"])
    end = float(project["trim"]["end"])
    dur = end - start
    n_frames = max(1, int(round(dur * FPS)))

    # ---- audio ----
    progress(0.02, "Saving your video — preparing audio")
    voice = pdir / "voice_clean.wav"
    if project.get("audio", {}).get("clean", True):
        if not voice.exists():
            audio_mod.clean_voice(src, voice)
    else:
        voice = pdir / "voice_raw.wav"
        if not voice.exists():
            from .media import run
            run(["ffmpeg", "-y", "-i", str(src), "-vn", "-ar", "48000", "-ac", "2", str(voice)])
    music = project.get("music", {})
    final_audio = pdir / "final_audio.m4a"
    audio_mod.mix_final(voice, final_audio, start, end,
                        music=music_path if music.get("enabled", True) else None,
                        music_volume=float(music.get("volume", 0.25)), duck=music.get("duck", True))

    # ---- static layers ----
    head = project.get("headline", {})
    head_img = headline_layer(head)
    head_np = head_box = None
    if head_img is not None:
        bbox = head_img.getbbox()
        if bbox:
            x0, y0, x1, y1 = bbox
            head_box = (x0, y0, x1, y1)
            head_np = _rgba_to_np(head_img.crop(bbox))
    logo = _logo_layer(project.get("logo", {}), logo_path)
    cap = project.get("captions", {})
    cap_style = cap.get("style", {})
    lines = cap.get("lines", []) if cap.get("enabled", True) else []
    zoom = project.get("zoom", {})
    track = project.get("faceTrack", [])
    broll = [b for b in project.get("broll", []) if not b.get("removed")]
    behind = head.get("behind", True)
    seg = PersonSegmenter() if head_np is not None and behind else None

    # ---- encoder ----
    enc = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
         "-r", str(FPS), "-i", "-", "-i", str(final_audio), "-map", "0:v", "-map", "1:a",
         "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-maxrate", "14M", "-bufsize", "28M",
         "-profile:v", "high", "-level", "4.2", "-pix_fmt", "yuv420p", "-c:a", "copy",
         "-movflags", "+faststart", "-shortest", str(out)],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    dec = _Decoder(src, sw, sh, start, dur)
    broll_dec, broll_cur = None, None
    cap_cache: dict = {}
    try:
        for i in range(n_frames):
            t = start + i / FPS
            src_frame = dec.read()
            if src_frame is None:
                raise RuntimeError("Could not read the source video.")

            b = broll_at(broll, t)
            if b is not None and (pdir / b["file"]).exists():
                if broll_cur is not b:
                    if broll_dec:
                        broll_dec.close()
                    broll_dec = _Decoder(pdir / b["file"], W, H, max(0.0, t - b["start"]))
                    broll_cur = b
                frame = broll_dec.read().copy()
            else:
                if broll_dec:
                    broll_dec.close()
                    broll_dec, broll_cur = None, None
                x, y, w, h = crop_rect(sw, sh, zoom, track, t)
                sx, sy = W / w, H / h
                m = np.float32([[sx, 0, -x * sx], [0, sy, -y * sy]])
                frame = cv2.warpAffine(src_frame, m, (W, H), flags=cv2.INTER_LINEAR,
                                       borderMode=cv2.BORDER_REPLICATE)
                if head_np is not None:
                    x0, y0, x1, y1 = head_box
                    rgb, a = head_np
                    if seg is not None:
                        person = seg.mask(frame, head_box)
                        a = a * (1 - person)
                    _blend(frame, rgb, a, x0, y0)

            if lines:
                hit = caption_at(lines, t)
                if hit:
                    ln, active, since = hit
                    anim = int(since * FPS) if since < 0.15 and cap_style.get("animation", "pop") == "pop" else -1
                    key = (ln["id"], " ".join(w["w"] for w in ln["words"]), active, anim)
                    if key not in cap_cache:
                        img, cx, cy = caption_image(cap_style, ln, active, since if anim >= 0 else 1.0)
                        cap_cache[key] = (*_rgba_to_np(img), cx, cy)
                    rgb, a, cx, cy = cap_cache[key]
                    _blend(frame, rgb, a, cx, cy)

            if logo:
                _blend(frame, *logo)

            enc.stdin.write(frame.tobytes())
            if i % 15 == 0:
                progress(0.05 + 0.93 * i / n_frames, "Saving your video")
        enc.stdin.close()
        err = enc.stderr.read().decode(errors="ignore")
        if enc.wait() != 0:
            raise RuntimeError(f"Video encoder failed: {err[-500:]}")
    finally:
        dec.close()
        if broll_dec:
            broll_dec.close()
        if seg:
            seg.close()
        if enc.poll() is None:
            enc.kill()
    progress(1.0, "Done")
