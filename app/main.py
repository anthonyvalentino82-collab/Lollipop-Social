"""LolliPOP Social — web server.

Run locally:  uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
import hashlib
import hmac
import re
import shutil
import uuid
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, jobs, projects

app = FastAPI(title="LolliPOP Social")
projects.cleanup_old()

AUTH_COOKIE = "lp_auth"


def _token() -> str:
    return hmac.new(config.APP_PASSWORD.encode(), b"lollipop-social", hashlib.sha256).hexdigest()


@app.middleware("http")
async def require_password(request: Request, call_next):
    path = request.url.path
    public = path == "/" or path.startswith("/static/") or path in (
        "/api/login", "/manifest.webmanifest", "/healthz") or path.startswith("/icons/")
    if config.APP_PASSWORD and not public:
        if not hmac.compare_digest(request.cookies.get(AUTH_COOKIE, ""), _token()):
            return JSONResponse({"detail": "login required"}, status_code=401)
    response = await call_next(request)
    # Make phones re-check the app's code on every visit so updates show up right away.
    if path == "/" or path.startswith(("/static/js/", "/static/css/")):
        response.headers["Cache-Control"] = "no-cache"
    return response


def _save_upload(upload: UploadFile, dst: Path) -> None:
    with open(dst, "wb") as fh:
        shutil.copyfileobj(upload.file, fh, length=1 << 20)


def _project_or_404(pid: str) -> dict:
    try:
        return projects.load(pid)
    except FileNotFoundError:
        raise HTTPException(404, "Project not found")


# ---------- auth / status ----------

@app.post("/api/login")
def login(password: str = Body(..., embed=True)):
    if not config.APP_PASSWORD or not hmac.compare_digest(password, config.APP_PASSWORD):
        raise HTTPException(401, "Wrong password")
    resp = JSONResponse({"ok": True})
    resp.set_cookie(AUTH_COOKIE, _token(), max_age=60 * 60 * 24 * 365, httponly=True, samesite="lax")
    return resp


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/status")
def status():
    """Tells the app which services are switched on."""
    return {
        "transcription": config.TRANSCRIBE_PROVIDER,
        "transcriptionReady": config.TRANSCRIBE_PROVIDER == "local" or bool(config.OPENAI_API_KEY),
        "stock": config.STOCK_ENABLED,
        "claude": bool(config.ANTHROPIC_API_KEY),
    }


# ---------- settings, logos, clips ----------

@app.get("/api/settings")
def get_settings():
    s = projects.load_settings()
    from .pipeline.text import user_fonts
    return {**s, "logos": projects.all_logos(s), "clips": projects.list_clips(), "fonts": user_fonts()}


@app.put("/api/settings")
def put_settings(patch: dict = Body(...)):
    patch.pop("logos", None)
    projects.save_settings(patch)
    return get_settings()


@app.post("/api/logos")
def add_logo(file: UploadFile = File(...), name: str = Form("My logo")):
    ext = Path(file.filename or "logo.png").suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        raise HTTPException(400, "Please upload a PNG (transparent background works best).")
    lid = uuid.uuid4().hex[:8]
    fname = f"{lid}{ext}"
    _save_upload(file, config.LOGOS_DIR / fname)
    s = projects.load_settings()
    projects.save_settings({"logos": s["logos"] + [{"id": lid, "name": name[:40], "file": fname}]})
    return get_settings()


@app.post("/api/fonts")
def add_font(file: UploadFile = File(...), name: str = Form("")):
    import json
    from PIL import ImageFont
    from .pipeline.text import FONTS, user_fonts
    ext = Path(file.filename or "font.ttf").suffix.lower()
    if ext not in (".ttf", ".otf"):
        raise HTTPException(400, "Please upload a .ttf or .otf font file.")
    fid = uuid.uuid4().hex[:8]
    dst = config.USER_FONTS_DIR / f"{fid}{ext}"
    _save_upload(file, dst)
    try:
        ImageFont.truetype(str(dst), 40)
    except OSError:
        dst.unlink(missing_ok=True)
        raise HTTPException(400, "That file isn't a font we can read.")
    name = re.sub(r"[^\w \-]", "", name or Path(file.filename or "My font").stem).strip()[:40] or "My font"
    taken = set(FONTS) | {f["name"] for f in user_fonts()}
    base, n = name, 2
    while name in taken:
        name, n = f"{base} {n}", n + 1
    fonts = user_fonts() + [{"id": fid, "name": name, "file": dst.name}]
    (config.USER_FONTS_DIR / "fonts.json").write_text(json.dumps(fonts, indent=2))
    return get_settings()


@app.delete("/api/fonts/{fid}")
def delete_font(fid: str):
    import json
    from .pipeline.text import user_fonts
    fonts = user_fonts()
    for f in fonts:
        if f["id"] == fid:
            (config.USER_FONTS_DIR / f["file"]).unlink(missing_ok=True)
    (config.USER_FONTS_DIR / "fonts.json").write_text(json.dumps([f for f in fonts if f["id"] != fid], indent=2))
    return get_settings()


@app.get("/files/fonts/{name}")
def font_file(name: str):
    f = (config.USER_FONTS_DIR / name).resolve()
    if f.parent != config.USER_FONTS_DIR.resolve() or not f.is_file() or f.suffix not in (".ttf", ".otf"):
        raise HTTPException(404)
    return FileResponse(f, headers={"Cache-Control": "max-age=31536000"})


@app.delete("/api/logos/{lid}")
def delete_logo(lid: str):
    s = projects.load_settings()
    keep = [l for l in s["logos"] if l["id"] != lid]
    for l in s["logos"]:
        if l["id"] == lid:
            (config.LOGOS_DIR / l["file"]).unlink(missing_ok=True)
    patch = {"logos": keep}
    if s["defaultLogo"] == lid:
        patch["defaultLogo"] = "lollipop"
    projects.save_settings(patch)
    return get_settings()


@app.post("/api/clips")
def add_clip(file: UploadFile = File(...), tag: str = Form(...)):
    tag = re.sub(r"\s+", " ", tag).strip().lower()[:40]
    if not tag:
        raise HTTPException(400, "Give the clip a short topic, like “keys” or “new home”.")
    cid = uuid.uuid4().hex[:8]
    ext = Path(file.filename or "clip.mov").suffix.lower() or ".mov"
    _save_upload(file, config.CLIPS_DIR / f"{cid}{ext}")
    clips = [c for c in projects.list_clips() if c["tag"] != tag]
    clips.append({"id": cid, "tag": tag, "file": f"{cid}{ext}"})
    projects.save_clips(clips)
    return {"clips": clips}


@app.delete("/api/clips/{cid}")
def delete_clip(cid: str):
    clips = projects.list_clips()
    for c in clips:
        if c["id"] == cid:
            (config.CLIPS_DIR / c["file"]).unlink(missing_ok=True)
    clips = [c for c in clips if c["id"] != cid]
    projects.save_clips(clips)
    return {"clips": clips}


# ---------- projects ----------

@app.get("/api/projects")
def list_projects():
    return projects.list_projects()


@app.post("/api/projects")
def create_project(file: UploadFile = File(...)):
    project, dst = projects.create(file.filename or "video.mov")
    _save_upload(file, dst)
    job = jobs.submit("prepare", project["id"], projects.prepare, project["id"])
    return {"project": project, "job": job}


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return _project_or_404(pid)


@app.put("/api/projects/{pid}")
def put_project(pid: str, patch: dict = Body(...)):
    _project_or_404(pid)
    return projects.update(pid, patch)


@app.get("/api/projects/{pid}/filmstrip")
def filmstrip(pid: str):
    """Thumbnail strip for the trim bar (made on first request for older projects)."""
    p = _project_or_404(pid)
    d = projects.pdir(pid)
    f = d / "filmstrip2.jpg"
    if not f.exists():
        if p.get("status") != "ready":
            raise HTTPException(409, "The video is still being prepared.")
        from .pipeline import media
        media.filmstrip(d / "source.mp4", f, p["source"]["duration"])
    return FileResponse(f, headers={"Cache-Control": "max-age=86400"})


@app.post("/api/projects/{pid}/auto-edit")
def auto_edit(pid: str):
    p = _project_or_404(pid)
    if p.get("status") != "ready":
        raise HTTPException(409, "The video is still being prepared.")
    return jobs.submit("auto-edit", pid, projects.auto_edit, pid)


@app.post("/api/projects/{pid}/broll/{bid}/swap")
def swap_broll(pid: str, bid: str):
    _project_or_404(pid)
    return jobs.submit("swap", pid, projects.swap_broll, pid, bid)


@app.post("/api/projects/{pid}/music")
def upload_music(pid: str, file: UploadFile = File(...)):
    p = _project_or_404(pid)
    d = projects.pdir(pid)
    for old in d.glob("music.*"):
        old.unlink()
    ext = Path(file.filename or "music.mp3").suffix.lower() or ".mp3"
    _save_upload(file, d / f"music{ext}")
    music = {**p["music"], "enabled": True, "file": f"music{ext}", "name": file.filename}
    return projects.update(pid, {"music": music})


@app.post("/api/projects/{pid}/render")
def render(pid: str):
    p = _project_or_404(pid)
    if p.get("status") != "ready":
        raise HTTPException(409, "The video is still being prepared.")
    return jobs.submit("render", pid, projects.render, pid)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found (the server may have restarted).")
    return job


# ---------- files ----------

@app.get("/files/projects/{pid}/{path:path}")
def project_file(pid: str, path: str):
    try:
        base = projects.pdir(pid).resolve()
    except FileNotFoundError:
        raise HTTPException(404)
    f = (base / path).resolve()
    if base not in f.parents or not f.is_file() or f.name == "project.json":
        raise HTTPException(404)
    headers = {"Cache-Control": "no-cache"}
    if f.name == "export.mp4":
        # inline so "Open video" plays it in Safari (Share → Save Video from there)
        headers["Content-Disposition"] = 'inline; filename="lollipop-video.mp4"'
    return FileResponse(f, headers=headers)


@app.get("/files/logos/{name}")
def logo_file(name: str):
    f = (config.LOGOS_DIR / name).resolve()
    if f.parent != config.LOGOS_DIR.resolve() or not f.is_file():
        raise HTTPException(404)
    return FileResponse(f)


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(config.STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/")
def index():
    return FileResponse(config.STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/icons", StaticFiles(directory=config.STATIC_DIR / "icons"), name="icons")
app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")
