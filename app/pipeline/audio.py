"""Voice cleanup and final audio mix (voice + ducked music)."""
import wave
from pathlib import Path

import numpy as np

from .media import run, run_with_progress

# Rumble cut -> FFT noise reduction -> presence boost for clarity -> gentle
# compression -> broadcast loudness (-16 LUFS, the level social apps expect).
VOICE_CHAIN = ",".join([
    "highpass=f=80",
    "afftdn=nr=10:nf=-40",
    "equalizer=f=200:t=q:w=1.2:g=-2",
    "equalizer=f=3200:t=q:w=1.0:g=3",
    "acompressor=threshold=-22dB:ratio=2.5:attack=15:release=250:makeup=2",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
])


def clean_voice(src: Path, dst: Path, duration: float = 0, on_progress=lambda f: None) -> None:
    """Writes a cleaned, loudness-balanced 48 kHz stereo WAV of the whole source."""
    run_with_progress(["ffmpeg", "-y", "-i", str(src), "-vn", "-af", VOICE_CHAIN,
                       "-ar", "48000", "-ac", "2", str(dst)], duration, on_progress)


def mix_final(voice: Path, dst: Path, segments: list[tuple[float, float]],
              music: Path | None = None, music_volume: float = 0.25, duck: bool = True) -> None:
    """Join the kept parts of the voice (trim + cuts) and optionally lay music under it.
    Each joint gets a 15 ms fade so cuts don't click. Music loops if it is too short,
    fades out at the end, and is pushed down whenever the voice is present (ducking)."""
    segments = segments or [(0.0, 0.1)]
    dur = max(0.1, sum(b - a for a, b in segments))
    parts = []
    for k, (a, b) in enumerate(segments):
        ln = b - a
        f = min(0.015, ln / 4)
        parts.append(f"[0:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS,"
                     f"afade=t=in:d={f:.3f},afade=t=out:st={max(0, ln - f):.3f}:d={f:.3f}[s{k}]")
    joined = "".join(f"[s{k}]" for k in range(len(segments)))
    voice_f = ";".join(parts) + f";{joined}concat=n={len(segments)}:v=0:a=1"
    if not music:
        run(["ffmpeg", "-y", "-i", str(voice), "-filter_complex", voice_f + "[out]",
             "-map", "[out]", "-c:a", "aac", "-b:a", "192k", str(dst)])
        return
    fade_st = max(0.0, dur - 1.5)
    music_f = (f"[1:a]aformat=sample_rates=48000:channel_layouts=stereo,"
               f"atrim=duration={dur:.3f},volume={music_volume:.3f},"
               f"afade=t=in:d=0.5,afade=t=out:st={fade_st:.3f}:d=1.5")
    if duck:
        graph = (f"{voice_f},asplit=2[v][sc];{music_f}[m];"
                 f"[m][sc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=450:makeup=1[md];"
                 f"[v][md]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]")
    else:
        graph = (f"{voice_f}[v];{music_f}[m];"
                 f"[v][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]")
    run(["ffmpeg", "-y", "-i", str(voice), "-stream_loop", "-1", "-i", str(music),
         "-filter_complex", graph, "-map", "[out]", "-t", f"{dur:.3f}",
         "-c:a", "aac", "-b:a", "192k", str(dst)])


def detect_silences(wav: Path, min_len: float = 0.7, noise_db: int = -35) -> list[tuple[float, float]]:
    """Quiet stretches (used to find pauses when there is no transcript)."""
    import re
    import subprocess
    proc = subprocess.run(["ffmpeg", "-i", str(wav), "-af", f"silencedetect=noise={noise_db}dB:d={min_len}",
                           "-f", "null", "-"], capture_output=True, text=True)
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", proc.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", proc.stderr)]
    return list(zip(starts, ends))


def word_energy(wav16k: Path, words: list[dict]) -> list[float]:
    """Loudness (RMS, dB) of each spoken word — used to find emphasis for auto zoom."""
    with wave.open(str(wav16k), "rb") as wf:
        raw = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    out = []
    for w in words:
        a, b = int(w["start"] * 16000), int(w["end"] * 16000)
        seg = raw[a:max(b, a + 1)]
        rms = float(np.sqrt(np.mean(seg ** 2))) if seg.size else 0.0
        out.append(20 * np.log10(rms + 1e-6))
    return out
