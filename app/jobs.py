"""Background jobs (prepare upload, auto edit, render). One heavy job runs at a
time so a small server isn't overwhelmed; the phone polls for progress."""
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor

_pool = ThreadPoolExecutor(max_workers=1)
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def submit(kind: str, project_id: str, fn, *args) -> dict:
    job = {"id": uuid.uuid4().hex[:12], "kind": kind, "project": project_id,
           "status": "queued", "progress": 0.0, "message": "Waiting…", "error": None, "result": None}
    with _lock:
        _jobs[job["id"]] = job

    def progress(p: float, msg: str):
        job["progress"] = round(min(1.0, max(0.0, p)), 3)
        job["message"] = msg

    def runner():
        job["status"] = "running"
        try:
            job["result"] = fn(*args, progress)
            job["progress"], job["status"], job["message"] = 1.0, "done", "Done"
        except Exception as exc:
            traceback.print_exc()
            job["status"], job["error"] = "error", str(exc)

    _pool.submit(runner)
    return job


def get(job_id: str) -> dict | None:
    return _jobs.get(job_id)
