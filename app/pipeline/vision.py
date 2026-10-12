"""On-server AI vision: person segmentation (headline behind speaker) and face
tracking (keeps the face framed during zooms). Uses Google MediaPipe models that
run locally on the CPU — no API key or per-use cost."""
import subprocess
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

from .. import config


def _guided_filter(guide: np.ndarray, src: np.ndarray, r: int = 7, eps: float = 1e-3) -> np.ndarray:
    """Edge-aware smoothing: makes the mask edge follow the real edges in the picture
    (hair, ears, shoulders) instead of the blocky low-resolution AI mask."""
    mean = lambda x: cv2.boxFilter(x, -1, (r, r))
    m_i, m_p = mean(guide), mean(src)
    a = (mean(guide * src) - m_i * m_p) / (mean(guide * guide) - m_i * m_i + eps)
    return mean(a) * guide + mean(m_p - a * m_i)


class VideoMatter:
    """Person cut-out with Robust Video Matting (RVM, MobileNetV3): a model made for cutting people
    out of video. Unlike the selfie models it keeps hats, caps, hair and glasses with the person,
    doesn't spill onto dark backgrounds, and remembers earlier frames, so the edge stays steady.

    It looks at the whole (shrunk) frame each time; the edge is then snapped to the full-size
    picture with the same edge-aware filter as before.
      quality "sharp" (default): 270x480 frame, ~60 ms;  "best": 360x640, ~1.4x slower.
    """

    MODEL = "rvm_mobilenetv3_fp32.onnx"

    def __init__(self, quality: str = "sharp"):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = int(config.FFMPEG_THREADS) - 1 or 1
        so.inter_op_num_threads = 1
        self._sess = ort.InferenceSession(str(config.MODELS_DIR / self.MODEL), so, providers=["CPUExecutionProvider"])
        self._size, self._ratio = ((360, 640), 0.5) if quality == "best" else ((270, 480), 0.667)
        self.reset()

    def reset(self):
        self._rec = [np.zeros((1, 1, 1, 1), np.float32)] * 4

    def _alpha(self, bgr: np.ndarray, warm: int = 1) -> np.ndarray:
        x = cv2.resize(bgr, self._size, interpolation=cv2.INTER_AREA)[:, :, ::-1].astype(np.float32) / 255.0
        x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
        ratio = np.array([self._ratio], np.float32)
        for _ in range(warm):
            out = self._sess.run(None, {"src": x, "r1i": self._rec[0], "r2i": self._rec[1],
                                        "r3i": self._rec[2], "r4i": self._rec[3], "downsample_ratio": ratio})
            self._rec = out[2:6]
        return out[1][0, 0]

    def mask(self, bgr: np.ndarray, box: tuple[int, int, int, int] | None = None, fresh: bool = False) -> np.ndarray:
        h, w = bgr.shape[:2]
        x0, y0, x1, y1 = box or (0, 0, w, h)
        if fresh:
            self.reset()
        # After a cut (or the first frame) the model has no memory yet: let it settle on this frame.
        pha = self._alpha(bgr, warm=3 if fresh or self._rec[0].shape[-1] == 1 else 1)
        sx, sy = pha.shape[1] / w, pha.shape[0] / h
        # The box in the small alpha (with a margin so the edge filter has context), then full size.
        m = cv2.resize(pha, (w, h), interpolation=cv2.INTER_LINEAR)[y0:y1, x0:x1] if (x1 - x0) * (y1 - y0) > 0.6 * w * h \
            else cv2.resize(pha[int(y0 * sy):max(int(y0 * sy) + 1, int(np.ceil(y1 * sy))),
                                int(x0 * sx):max(int(x0 * sx) + 1, int(np.ceil(x1 * sx)))], (x1 - x0, y1 - y0),
                            interpolation=cv2.INTER_LINEAR)
        # Snap the edge to the real picture at half size, then firm it up (clean, not soft).
        bw, bh = x1 - x0, y1 - y0
        hw, hh = max(32, bw // 2), max(32, bh // 2)
        guide = cv2.cvtColor(cv2.resize(bgr[y0:y1, x0:x1], (hw, hh), interpolation=cv2.INTER_AREA),
                             cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        g = _guided_filter(guide, cv2.resize(m, (hw, hh), interpolation=cv2.INTER_AREA))
        g = np.clip((g - 0.35) / 0.3, 0, 1)
        return cv2.resize(g, (bw, bh), interpolation=cv2.INTER_LINEAR)

    def close(self):
        self._sess = None


def make_segmenter(quality: str = "sharp"):
    """The best cut-out available: video matting when its model is installed, else MediaPipe."""
    if (config.MODELS_DIR / VideoMatter.MODEL).exists():
        try:
            return VideoMatter(quality)
        except Exception as exc:  # noqa: BLE001 — never block a save over the cut-out model
            print(f"[vision] video matting unavailable ({exc}); using MediaPipe")
    return PersonSegmenter(quality)


class PersonSegmenter:
    """Soft 0..1 mask of where the person is, for the headline area of each frame.

    quality "sharp" (default): fast selfie model on a square crop + edge snapping.
    quality "best": detailed multi-class model (hair/body/face) + edge snapping; ~3x slower.
    """

    def __init__(self, quality: str = "sharp", smoothing: float = 0.3):
        best = quality == "best"
        model = "selfie_multiclass_256x256.tflite" if best else "selfie_segmenter.tflite"
        self._person_from_background = best  # multiclass: channel 0 = background
        self._seg = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
            base_options=BaseOptions(model_asset_path=str(config.MODELS_DIR / model)),
            running_mode=vision.RunningMode.IMAGE,
            output_confidence_masks=True, output_category_mask=False))
        self._prev = {}
        self._smoothing = smoothing
        # "Spill guard" for the fast model: on dark backgrounds it sometimes marks dark areas next
        # to the head (cabinets, car interior) as person, hiding headline letters in empty space.
        # A few times a second the detailed model checks where the person really is, and anything
        # well outside that is dropped. Cheap: one pass on ~1 frame in 8.
        self._guard_seg = None if best else vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
            base_options=BaseOptions(model_asset_path=str(config.MODELS_DIR / "selfie_multiclass_256x256.tflite")),
            running_mode=vision.RunningMode.IMAGE, output_confidence_masks=True, output_category_mask=False))
        self._guard, self._guard_age, self._guard_key = None, 99, None
        self.guard_every = 8

    def mask(self, bgr: np.ndarray, box: tuple[int, int, int, int] | None = None, fresh: bool = False) -> np.ndarray:
        """Person mask for the `box` (x0, y0, x1, y1) region of the frame (whole frame if None)."""
        import math
        h, w = bgr.shape[:2]
        x0, y0, x1, y1 = box or (0, 0, w, h)
        bw, bh = x1 - x0, y1 - y0
        # The model sees a 256x256 square. Feeding it square crops around the headline
        # (instead of squashing the tall 9:16 frame) avoids stretched, jagged edges.
        side = min(w, h, int(max(bw, bh) * 1.1))
        cx = (x0 + x1) // 2
        sx = max(0, min(w - side, cx - side // 2))
        # A tall headline doesn't fit in one square (a square can't be taller than the
        # frame is wide), so cover it with overlapping squares stacked top to bottom.
        top = max(0, y0 - int(bh * 0.05))
        bottom = min(h, y1 + int(bh * 0.05))
        n = max(1, math.ceil((bottom - top - side * 0.15) / (side * 0.85)))
        if n == 1:
            ys = [max(0, min(h - side, (y0 + y1) // 2 - side // 2))]
        else:
            last = min(h - side, bottom - side)
            ys = [round(top + (last - top) * i / (n - 1)) for i in range(n)]
        out = np.zeros((bh, bw), np.float32)
        for i, sy in enumerate(ys):
            # Every square is checked on every frame (skipping "empty" ones let hair that
            # moved into them show through the headline for a moment).
            m = self._square(bgr, sx, sy, side, i)
            ox0, oy0 = max(x0, sx), max(y0, sy)
            ox1, oy1 = min(x1, sx + side), min(y1, sy + side)
            if ox1 > ox0 and oy1 > oy0:
                dst = out[oy0 - y0:oy1 - y0, ox0 - x0:ox1 - x0]
                np.maximum(dst, m[oy0 - sy:oy1 - sy, ox0 - sx:ox1 - sx], out=dst)
        if self._guard_seg is not None:
            key = (box, bw, bh)
            if fresh or self._guard is None or self._guard_key != key or self._guard_age >= self.guard_every:
                self._guard = self._spill_guard(bgr, x0, y0, x1, y1)
                self._guard_age, self._guard_key = 0, key
            self._guard_age += 1
            out *= self._guard
        return out

    def _spill_guard(self, bgr, x0, y0, x1, y1) -> np.ndarray:
        """Where the detailed model sees the person (hair included), grown by a margin that covers
        movement until the next check, with a soft edge so nothing gets clipped harshly.
        One pass over the whole headline area: it only needs to be roughly right."""
        bw, bh = x1 - x0, y1 - y0
        small = cv2.cvtColor(cv2.resize(bgr[y0:y1, x0:x1], (256, 256), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        res = self._guard_seg.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(small)))
        g = 1.0 - res.confidence_masks[0].numpy_view().reshape(256, 256).astype(np.float32)
        side = min(bw, bh)
        # Grow + soften at quarter size (the guard only needs to be roughly right), then scale up.
        q = 4
        small = cv2.resize((g > 0.35).astype(np.float32), (max(1, bw // q), max(1, bh // q)), interpolation=cv2.INTER_LINEAR)
        r = max(2, int(side * 0.022 / q))  # ~25 px on a 1080 video: plenty for normal head movement between checks
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
        small = cv2.GaussianBlur(cv2.dilate((small > 0.05).astype(np.float32), k), (0, 0), max(1.0, r / 3))
        return cv2.resize(small, (bw, bh), interpolation=cv2.INTER_LINEAR)

    def _square(self, bgr: np.ndarray, sx: int, sy: int, side: int, idx: int) -> np.ndarray:
        crop = bgr[sy:sy + side, sx:sx + side]
        small = cv2.cvtColor(cv2.resize(crop, (256, 256), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        res = self._seg.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(small)))
        m = res.confidence_masks[0].numpy_view().reshape(256, 256).astype(np.float32)
        if self._person_from_background:
            m = 1.0 - m
        # Light temporal smoothing (per square) stops flicker without dragging behind movement.
        prev = self._prev.get(idx) if isinstance(self._prev, dict) else None
        if prev is not None and prev.shape == m.shape:
            m = self._smoothing * prev + (1 - self._smoothing) * m
        if not isinstance(self._prev, dict):
            self._prev = {}
        self._prev[idx] = m
        # Snap the edge to the picture at half the crop's resolution, then firm it up.
        half = max(64, side // 2)
        guide = cv2.cvtColor(cv2.resize(crop, (half, half), interpolation=cv2.INTER_AREA),
                             cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        m = _guided_filter(guide, cv2.resize(m, (half, half), interpolation=cv2.INTER_LINEAR))
        m = np.clip((m - 0.4) / 0.25, 0, 1)
        return cv2.resize(m, (side, side), interpolation=cv2.INTER_LINEAR)

    def reset(self):
        self._prev = {}
        self._guard = None

    def close(self):
        self._seg.close()
        if self._guard_seg is not None:
            self._guard_seg.close()


def face_track(video: Path, width: int, height: int, duration: float, step: float = 0.25,
               on_progress=lambda f: None) -> list:
    """[[t, x, y], ...] normalised face centre sampled every `step` seconds and smoothed."""
    det = vision.FaceDetector.create_from_options(vision.FaceDetectorOptions(
        base_options=BaseOptions(model_asset_path=str(config.MODELS_DIR / "blaze_face_short_range.tflite")),
        running_mode=vision.RunningMode.IMAGE, min_detection_confidence=0.5))
    # Decode small frames at 1/step fps straight from ffmpeg.
    sw = 480 if width >= height else int(480 * width / height) // 2 * 2
    sh = int(sw * height / width) // 2 * 2
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"fps={1/step},scale={sw}:{sh}",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    raw = []
    i = 0
    frame_bytes = sw * sh * 3
    while True:
        buf = proc.stdout.read(frame_bytes)
        if len(buf) < frame_bytes:
            break
        frame = np.frombuffer(buf, np.uint8).reshape(sh, sw, 3)
        r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(frame)))
        if r.detections:
            best = max(r.detections, key=lambda d: d.bounding_box.width * d.bounding_box.height)
            bb = best.bounding_box
            raw.append((i * step, (bb.origin_x + bb.width / 2) / sw, (bb.origin_y + bb.height / 2) / sh))
        else:
            raw.append((i * step, None, None))
        i += 1
        if duration > 0 and i % 8 == 0:
            on_progress(min(1.0, i * step / duration))
    proc.wait()
    det.close()
    return _smooth(raw)


def _smooth(raw: list, window: int = 7) -> list:
    pts = [(t, x, y) for t, x, y in raw if x is not None]
    if not pts:
        return []
    # Fill gaps (face turned away) with the nearest known position.
    filled, last = [], pts[0]
    for t, x, y in raw:
        if x is not None:
            last = (t, x, y)
        filled.append((t, last[1], last[2]))
    xs = np.array([p[1] for p in filled])
    ys = np.array([p[2] for p in filled])
    k = np.ones(window) / window
    pad = window // 2
    xs = np.convolve(np.pad(xs, pad, mode="edge"), k, mode="valid")
    ys = np.convolve(np.pad(ys, pad, mode="edge"), k, mode="valid")
    return [[round(filled[i][0], 3), round(float(xs[i]), 4), round(float(ys[i]), 4)]
            for i in range(len(filled))]
