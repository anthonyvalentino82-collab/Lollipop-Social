"""Background jobs (prepare upload, auto edit, render).

Each heavy job runs in its own low-priority child process, so:
  * the web server always stays responsive (Render's health checks keep passing
    even while a video renders on a 1-CPU server), and
  * if a job crashes or runs out of memory, the app survives and the phone gets
    a clear error instead of "502".
One job runs at a time so a small server isn't overwhelmed; the phone polls for progress.
"""
import json
import multiprocessing as mp
import os
import queue
import threading
import traceback
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor

from . import config

# Job status is also written to disk, so it can be read no matter which copy of the web server
# answers (with more than one, a job looked "not found" — like a restart — to the phone).
JOBS_DIR = config.DATA_DIR / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)
STALE_AFTER = 60  # a running job's file is refreshed every few seconds; older = its server is gone


def _persist(job: dict) -> None:
    try:
        tmp = JOBS_DIR / f".{job['id']}.tmp"
        tmp.write_text(json.dumps({**job, "beat": time.time()}, default=str))
        tmp.replace(JOBS_DIR / f"{job['id']}.json")
    except Exception:  # noqa: BLE001 — never let bookkeeping break a job
        pass


_pool = ThreadPoolExecutor(max_workers=1)
_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_ctx = mp.get_context("spawn")
history: deque = deque(maxlen=40)  # recent finished jobs, for "Report a problem"  # fresh interpreter: safe with MediaPipe/OpenCV threads


def _child(fn, args, q):
    """Runs inside the child process."""
    try:
        os.nice(10)  # let the web server win whenever the CPU is busy
    except OSError:
        pass
    try:
        result = fn(*args, lambda p, msg: q.put(("progress", p, msg)))
        q.put(("done", result, None))
    except Exception as exc:
        traceback.print_exc()
        q.put(("error", str(exc), traceback.format_exc()[-4000:]))


def submit(kind: str, project_id: str, fn, *args) -> dict:
    job = {"id": uuid.uuid4().hex[:12], "kind": kind, "project": project_id,
           "status": "queued", "progress": 0.0, "message": "Waiting…", "error": None, "result": None}
    with _lock:
        _jobs[job["id"]] = job
    _persist(job)
    for old in sorted(JOBS_DIR.glob("*.json"), key=lambda f: f.stat().st_mtime)[:-200]:
        old.unlink(missing_ok=True)

    def runner():
        job["status"] = "running"
        job["message"] = "Starting…"
        t0 = time.time()
        last = 0.0
        q = _ctx.Queue()
        proc = _ctx.Process(target=_child, args=(fn, args, q), daemon=True)
        proc.start()
        finished = False
        while not finished:
            if time.time() - last > 3:
                _persist(job)
                last = time.time()
            try:
                kind_, a, b = q.get(timeout=1.0)
            except queue.Empty:
                if not proc.is_alive():
                    # Drain anything sent just before exit, then give up.
                    try:
                        kind_, a, b = q.get(timeout=1.0)
                    except queue.Empty:
                        code = proc.exitcode
                        job["status"] = "error"
                        job["error"] = ("The video process stopped unexpectedly"
                                        + (" (it ran out of memory — try a shorter video, or upgrade the Render plan)."
                                           if code in (-9, 137) else f" (code {code}). Please try again."))
                        break
                else:
                    continue
            if kind_ == "progress":
                job["progress"] = round(min(1.0, max(0.0, a)), 3)
                job["message"] = b
            elif kind_ == "done":
                job["result"] = a
                job["progress"], job["status"], job["message"] = 1.0, "done", "Done"
                finished = True
            elif kind_ == "error":
                job["status"], job["error"], job["trace"] = "error", a, b
                finished = True
        proc.join(timeout=10)
        _persist(job)
        history.append({"id": job["id"], "kind": job["kind"], "project": job["project"],
                        "status": job["status"], "error": job["error"], "trace": job.get("trace"),
                        "started": t0, "seconds": round(time.time() - t0, 1), "exitcode": proc.exitcode})

    _pool.submit(runner)
    return job


def get(job_id: str) -> dict | None:
    job = _jobs.get(job_id)
    if job:
        return job
    if not job_id.isalnum():
        return None
    try:
        job = json.loads((JOBS_DIR / f"{job_id}.json").read_text())
    except (OSError, ValueError):
        return None
    if job.get("status") in ("queued", "running") and time.time() - job.get("beat", 0) > STALE_AFTER:
        return None  # the server that ran it restarted: the phone starts it again
    return job
