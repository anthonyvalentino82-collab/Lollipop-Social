"""Background jobs (prepare upload, auto edit, render).

Each heavy job runs in its own low-priority child process, so:
  * the web server always stays responsive (Render's health checks keep passing
    even while a video renders on a 1-CPU server), and
  * if a job crashes or runs out of memory, the app survives and the phone gets
    a clear error instead of "502".
One job runs at a time so a small server isn't overwhelmed; the phone polls for progress.
"""
import multiprocessing as mp
import os
import queue
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor

_pool = ThreadPoolExecutor(max_workers=1)
_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_ctx = mp.get_context("spawn")  # fresh interpreter: safe with MediaPipe/OpenCV threads


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
        q.put(("error", str(exc), None))


def submit(kind: str, project_id: str, fn, *args) -> dict:
    job = {"id": uuid.uuid4().hex[:12], "kind": kind, "project": project_id,
           "status": "queued", "progress": 0.0, "message": "Waiting…", "error": None, "result": None}
    with _lock:
        _jobs[job["id"]] = job

    def runner():
        job["status"] = "running"
        job["message"] = "Starting…"
        q = _ctx.Queue()
        proc = _ctx.Process(target=_child, args=(fn, args, q), daemon=True)
        proc.start()
        finished = False
        while not finished:
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
                job["status"], job["error"] = "error", a
                finished = True
        proc.join(timeout=10)

    _pool.submit(runner)
    return job


def get(job_id: str) -> dict | None:
    return _jobs.get(job_id)
