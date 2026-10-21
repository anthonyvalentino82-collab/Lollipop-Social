"""Settings read from environment variables (see .env.example)."""
import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
FONTS_DIR = STATIC_DIR / "fonts"
MODELS_DIR = APP_DIR / "models"

DATA_DIR = Path(os.environ.get("DATA_DIR", APP_DIR.parent / "data")).resolve()
PROJECTS_DIR = DATA_DIR / "projects"
LOGOS_DIR = DATA_DIR / "logos"
CLIPS_DIR = DATA_DIR / "clips"
USER_FONTS_DIR = DATA_DIR / "fonts"
for d in (PROJECTS_DIR, LOGOS_DIR, CLIPS_DIR, USER_FONTS_DIR):
    d.mkdir(parents=True, exist_ok=True)

# Optional password protecting the whole app (strongly recommended once online).
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")

# Private key that lets Claude read "Report a problem" reports and recordings (debug only).
DEBUG_KEY = os.environ.get("DEBUG_KEY", "")
REPORTS_DIR = DATA_DIR / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

# Transcription: "openai" (whisper-1, paid, fast) or "local" (faster-whisper, free, slower).
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
TRANSCRIBE_PROVIDER = os.environ.get("TRANSCRIBE_PROVIDER", "openai" if OPENAI_API_KEY else "local")
LOCAL_WHISPER_MODEL = os.environ.get("LOCAL_WHISPER_MODEL", "base.en")

# B-roll: Pexels (free licensed stock video). Claude picks smarter moments/search terms if set.
PEXELS_API_KEY = os.environ.get("PEXELS_API_KEY", "")
PIXABAY_API_KEY = os.environ.get("PIXABAY_API_KEY", "")
STOCK_ENABLED = bool(PEXELS_API_KEY or PIXABAY_API_KEY)
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
# What the videos are about: steers B-roll toward fitting, American footage.
BROLL_NICHE = os.environ.get("BROLL_NICHE", "real estate, mortgages, homeownership, money and generational wealth")
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")

OUT_W, OUT_H, OUT_FPS = 1080, 1920, 30
# Final export encoding: CRF 18 (visually lossless) capped at 12 Mbps. "slow" squeezes a bit more
# quality per MB but is much slower on a 1-CPU server; "veryfast" (the default) saves about 2.4x
# faster than "medium" at the same CRF, with slightly bigger files.
EXPORT_PRESET = os.environ.get("EXPORT_PRESET", "veryfast")
# Threads per ffmpeg encode/decode. Servers often report the host's many CPU cores; letting
# ffmpeg start a worker (with its own full-HD frames) per reported core runs out of memory.
FFMPEG_THREADS = os.environ.get("FFMPEG_THREADS", "3")
