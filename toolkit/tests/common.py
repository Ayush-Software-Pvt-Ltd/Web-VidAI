"""Shared helpers of the toolkit tests: import path, a clean environment, tiny media."""
import contextlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
TOOLKIT = TESTS.parent
KIT = TOOLKIT / "CLAUDE_VE_ALL"
DATA = TESTS / "data"
FAKE_NPX = TESTS / "support" / "fake_npx.py"
sys.path.insert(0, str(KIT))
sys.dont_write_bytecode = True

# every variable the toolkit reads (SPEC section 9 and vekit/tools.py)
VE_VARS = ("VE_CPU_CORES", "VE_GPU_SLOTS_DIR", "VE_JOB_ID", "VE_HW", "VE_CHANNEL_DIR", "VE_FFMPEG",
           "VE_FFPROBE", "VE_NPX", "VE_NODE", "VE_HYPERFRAMES", "VE_ASR_BACKEND", "VE_ASR_DEVICE", "VE_FONT", "VE_ALLOW_2160")


def clean_env(**extra):
    """A copy of os.environ without any VE_* variable, plus `extra`."""
    env = {k: v for k, v in os.environ.items() if k not in VE_VARS}
    env.update(extra)
    return env


class Case(unittest.TestCase):
    """A test with a temporary folder and an environment that has no VE_* variables."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vekit-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        patcher = mock.patch.dict(os.environ, clean_env(), clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        from vekit import resources
        resources.reset_cache()
        self.addCleanup(resources.reset_cache)

    def env(self, **values):
        patcher = mock.patch.dict(os.environ, values)
        patcher.start()
        self.addCleanup(patcher.stop)


def have_ffmpeg():
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def make_clip(path, *, size="320x180", seconds=1, fps=24, audio=True):
    """A tiny H.264 clip (flat colour, sine tone); flat colour compresses to a few KB."""
    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x5a6e8c:s={size}:r={fps}:d={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=f=300:d={seconds}:r=48000", "-shortest", "-c:a", "aac"]
    args += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL)
    return Path(path)


@contextlib.contextmanager
def no_new_files(root):
    """Fails when `root` (a folder that must only be read) gains, loses or changes a file."""
    def snapshot():
        return {p: (p.stat().st_size, p.stat().st_mtime_ns) for p in Path(root).rglob("*") if p.is_file()}
    before = snapshot()
    yield
    after = snapshot()
    if before != after:
        changed = sorted(str(p) for p in set(before) ^ set(after))[:10] or \
            sorted(str(p) for p in before if before[p] != after[p])[:10]
        raise AssertionError(f"{root} was written to: {changed}")
