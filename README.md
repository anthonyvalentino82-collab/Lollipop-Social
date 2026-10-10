# LolliPOP Social

*A sweeter way to communicate.* A mobile-first AI video editor that extends LolliPOP:

**Record or upload → Auto Edit → small adjustments → Save to iPhone.**

👉 **Setup instructions (plain English): [SETUP.md](SETUP.md)**

## What Auto Edit does
| Feature | How it works | Service |
|---|---|---|
| Logo overlay | Your saved LolliPOP / Horizon Pacific Lending PNG. Drag it, pinch to resize, save the position as your default | built-in |
| Animated captions | Word-timed transcription; the spoken word is highlighted; fix words, font, size, color and position | OpenAI Whisper (or free local faster-whisper) |
| Cinematic headline | Static text you type, drawn **behind** your head and body with AI person segmentation; `*stars*` mark accent words | Google MediaPipe, runs on the server and in the browser preview |
| Auto zoom | Eased push-ins on emphasized words (loudness + pauses + sentence starts); the face stays framed by face tracking | MediaPipe face detector |
| Auto audio | High-pass, FFT noise reduction, presence EQ, compression, −16 LUFS loudness | ffmpeg |
| Auto B-roll | Picks moments from the transcript and fetches portrait stock footage (or your own tagged clips); your voice keeps playing | Pixabay and/or Pexels (+ optional Claude for picking moments) |
| Music | Your audio file, looped, faded, and **ducked under your voice** with a sidechain compressor; volume control | ffmpeg |
| Cut & remove pauses | Cut any section out of the middle on the filmstrip; AI removes dead air between sentences (toggle) | built-in |
| Brand fonts | Upload your own .ttf/.otf fonts for captions and headlines | built-in |

Export: **1080×1920, 30 fps, H.264 High / AAC MP4** with faststart. It's ready for Photos, iMessage, Instagram, TikTok, Facebook, LinkedIn and YouTube Shorts. The headline and captions are separate layers in both the preview and the export.

## Interface
One screen: preview · ▶ · **✨ AI Edit** (analysis, then 7 guided steps: trim & cut, caption style, headline, logo, zoom, B-roll, music) · **Save Video** (full-screen result with Save to iPhone). Manual tools live under "Fine-tune manually".

## How it's built
- `app/main.py`: FastAPI web server and API (an optional password protects everything).
- `app/projects.py`: project storage plus the prepare / auto-edit / render steps (background jobs).
- `app/pipeline/`
  - `media.py`: ffmpeg helpers; iPhone HEVC/HDR/rotation → H.264 SDR working copy
  - `audio.py`: voice cleanup, music ducking mix
  - `transcribe.py`: OpenAI / local transcription
  - `vision.py`: segmentation and face tracking
  - `zoom.py`: emphasis → zoom plan
  - `broll.py`: moments, Pixabay/Pexels, user clips
  - `text.py`: headline and caption drawing
  - `timeline.py`: shared timing math
  - `render.py`: frame compositor → MP4
- `app/static/`: the phone web app (plain JS, no build step). `js/timeline.js` mirrors `pipeline/timeline.py` so the preview matches the export.

Project data lives in `DATA_DIR` (default `./data`; `/data` on Render). Projects older than 14 days are cleaned up automatically.
