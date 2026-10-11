# LolliPOP Social — one container: web app + video pipeline.
FROM python:3.11-slim

# ffmpeg = video/audio processing; libegl1/libgles2 are needed by MediaPipe (AI person cut-out).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libegl1 libgles2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the free local transcription model so the first video isn't slow.
# (Only used when no OPENAI_API_KEY is set.)
ARG LOCAL_WHISPER_MODEL=base.en
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${LOCAL_WHISPER_MODEL}', device='cpu', compute_type='int8')"

COPY app ./app

ENV DATA_DIR=/data PYTHONUNBUFFERED=1 PORT=8000
EXPOSE 8000
# Exactly one web process: jobs run one at a time from it. (Render may set WEB_CONCURRENCY on
# bigger plans, which would start several copies that don't know each other's jobs.)
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
