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

# Transcription: "openai" (whisper-1, paid, fast) or "local" (faster-whisper, free, slower).
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
TRANSCRIBE_PROVIDER = os.environ.get("TRANSCRIBE_PROVIDER", "openai" if OPENAI_API_KEY else "local")
LOCAL_WHISPER_MODEL = os.environ.get("LOCAL_WHISPER_MODEL", "base.en")

# B-roll: Pexels (free licensed stock video). Claude picks smarter moments/search terms if set.
PEXELS_API_KEY = os.environ.get("PEXELS_API_KEY", "")
PIXABAY_API_KEY = os.environ.get("PIXABAY_API_KEY", "")
STOCK_ENABLED = bool(PEXELS_API_KEY or PIXABAY_API_KEY)
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")

OUT_W, OUT_H, OUT_FPS = 1080, 1920, 30
