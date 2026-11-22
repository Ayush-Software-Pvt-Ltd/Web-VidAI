"""A temporary work folder whose removal never fails.

`tempfile.TemporaryDirectory` raises when its folder cannot be deleted.  On Windows that happens
whenever Chrome or ffmpeg still holds a file for a moment after the render (WinError 32), and the
exception then discards the result of a render that had already succeeded.  `scratch_dir` retries
the removal a few times and, when a file stays locked, leaves the folder to the operating
system's temporary-file cleanup: it never raises.
"""
import contextlib
import shutil
import tempfile
import time
from pathlib import Path

ATTEMPTS = 5
PAUSE = 0.3


def remove_tree(path, attempts=ATTEMPTS, pause=PAUSE, sleep=time.sleep):
    """Delete a folder tree, trying again while files are locked.  Returns True when it is gone."""
    for n in range(attempts):
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            return True
        except OSError:
            if n + 1 < attempts:
                sleep(pause)
            continue
        return True
    shutil.rmtree(path, ignore_errors=True)
    return not Path(path).exists()


@contextlib.contextmanager
def scratch_dir(prefix="ve_"):
    """Like `tempfile.TemporaryDirectory(prefix=...)` as a context manager that yields the path (a
    str), except that leaving it never raises."""
    path = tempfile.mkdtemp(prefix=prefix)
    try:
        yield path
    finally:
        try:
            remove_tree(path)
        except Exception:               # a failing cleanup must never hide the result or the real error
            pass
