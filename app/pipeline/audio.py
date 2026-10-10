"""Voice cleanup and final audio mix (voice + ducked music)."""
import wave
from pathlib import Path

import numpy as np

from .media import run, run_with_progress

# Rumble cut -> FFT noise reduction -> presence boost for clarity -> gentle
# compression -> broadcast loudness (-16 LUFS, the level social apps expect).
VOICE_CHAIN = ",".join([
    "highpass=f=80",
    "afftdn=nr=14:nf=-35:tn=1",
    "equalizer=f=200:t=q:w=1.2:g=-2",
    "equalizer=f=3200:t=q:w=1.0:g=3",
    "acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=2",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
])


def clean_voice(src: Path, dst: Path, duration: float = 0, on_progress=lambda f: None) -> None:
    """Writes a cleaned, loudness-balanced 48 kHz stereo WAV of the whole source."""
    run_with_progress(["ffmpeg", "-y", "-i", str(src), "-vn", "-af", VOICE_CHAIN,
                       "-ar", "48000", "-ac", "2", str(dst)], duration, on_progress)


def mix_final(voice: Path, dst: Path, start: float, end: float,
              music: Path | None = None, music_volume: float = 0.25, duck: bool = True) -> None:
    """Trim the voice to [start, end] and optionally lay music under it.
    Music loops if it is too short, fades out at the end, and is pushed down
    automatically whenever the voice is present (sidechain ducking)."""
    dur = max(0.1, end - start)
    voice_f = f"[0:a]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS"
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
