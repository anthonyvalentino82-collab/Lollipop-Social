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


class PersonSegmenter:
    """Returns a soft 0..1 mask of where the person is in each frame."""

    def __init__(self, smoothing: float = 0.5):
        self._seg = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
            base_options=BaseOptions(model_asset_path=str(config.MODELS_DIR / "selfie_segmenter.tflite")),
            running_mode=vision.RunningMode.IMAGE,
            output_confidence_masks=True, output_category_mask=False))
        self._prev = None
        self._smoothing = smoothing

    def mask(self, bgr: np.ndarray, box: tuple[int, int, int, int] | None = None) -> np.ndarray:
        """Person mask for the frame, or only for the `box` (x0, y0, x1, y1) region of it."""
        h, w = bgr.shape[:2]
        small = cv2.cvtColor(cv2.resize(bgr, (256, 256), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        res = self._seg.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(small)))
        m = res.confidence_masks[0].numpy_view().reshape(256, 256).astype(np.float32)
        # Temporal smoothing stops the edge from flickering between frames.
        if self._prev is not None:
            m = self._smoothing * self._prev + (1 - self._smoothing) * m
        self._prev = m
        # Firm up and feather the edge at half resolution (much faster), then upscale.
        hw, hh = w // 2, h // 2
        m = cv2.resize(m, (hw, hh), interpolation=cv2.INTER_LINEAR)
        m = np.clip((m - 0.35) / 0.3, 0, 1)
        m = cv2.GaussianBlur(m, (0, 0), sigmaX=max(1.0, hw / 540))
        x0, y0, x1, y1 = box or (0, 0, w, h)
        part = m[y0 // 2:max(y0 // 2 + 1, (y1 + 1) // 2), x0 // 2:max(x0 // 2 + 1, (x1 + 1) // 2)]
        return cv2.resize(part, (x1 - x0, y1 - y0), interpolation=cv2.INTER_LINEAR)

    def reset(self):
        self._prev = None

    def close(self):
        self._seg.close()


def face_track(video: Path, width: int, height: int, duration: float, step: float = 0.25) -> list:
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
