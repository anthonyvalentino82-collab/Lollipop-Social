"""Speech-to-text with word-level timestamps.

Two providers:
  * openai — OpenAI Whisper API (whisper-1). Paid (about $0.006 per minute), fast, accurate.
  * local  — faster-whisper running on the server. Free, but slower and needs more RAM.
"""
import re
from pathlib import Path

import httpx

from .. import config
from .media import run

_local_model = None


def transcribe(audio_src: Path, workdir: Path) -> list[dict]:
    """Returns [{"w": "word", "start": sec, "end": sec}, ...]."""
    if config.TRANSCRIBE_PROVIDER == "openai":
        words = _openai(audio_src, workdir)
    else:
        words = _local(audio_src, workdir)
    return _clean(words)


def _clean(words: list[dict]) -> list[dict]:
    out = []
    for w in words:
        text = w["w"].strip()
        if not text:
            continue
        start, end = float(w["start"]), float(w["end"])
        if end <= start:
            end = start + 0.08
        out.append({"w": text, "start": round(start, 3), "end": round(end, 3)})
    return out


def _openai(src: Path, workdir: Path) -> list[dict]:
    if not config.OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is not set, so captions can't be transcribed.")
    # Small mono MP3 keeps us far below the API's 25 MB upload limit.
    mp3 = workdir / "speech.mp3"
    run(["ffmpeg", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", str(mp3)])
    with open(mp3, "rb") as fh:
        resp = httpx.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {config.OPENAI_API_KEY}"},
            data={"model": "whisper-1", "response_format": "verbose_json",
                  "timestamp_granularities[]": "word"},
            files={"file": ("speech.mp3", fh, "audio/mpeg")},
            timeout=300,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"OpenAI transcription failed ({resp.status_code}): {resp.text[:300]}")
    data = resp.json()
    words = [{"w": w["word"], "start": w["start"], "end": w["end"]} for w in data.get("words", [])]
    return _restore_punctuation(words, data.get("text", ""))


def _restore_punctuation(words: list[dict], text: str) -> list[dict]:
    """Whisper's word list has no punctuation; copy it back from the full text
    so captions can break at sentence ends."""
    tokens = text.split()
    ti = 0
    for w in words:
        bare = re.sub(r"\W", "", w["w"]).lower()
        while ti < len(tokens):
            tok = tokens[ti]
            ti += 1
            if re.sub(r"\W", "", tok).lower() == bare:
                w["w"] = tok
                break
    return words


def _local(src: Path, workdir: Path) -> list[dict]:
    global _local_model
    from faster_whisper import WhisperModel  # imported lazily: heavy

    if _local_model is None:
        _local_model = WhisperModel(config.LOCAL_WHISPER_MODEL, device="cpu", compute_type="int8")
    segments, _ = _local_model.transcribe(str(src), word_timestamps=True, vad_filter=True)
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"w": w.word, "start": w.start, "end": w.end})
    return words
