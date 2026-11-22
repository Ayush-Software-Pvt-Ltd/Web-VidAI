"""The one place for resource limits and hardware choices (SPEC section 9, Resource limits).

The server tells every job process how much of the machine it may use:

  VE_CPU_CORES        processors this job may use (absent: all of them)
  VE_GPU_SLOTS_DIR    folder with limits.json and the slot-<i> files (absent: no GPU limit)
  VE_JOB_ID           the job's id, written into the slot files
  VE_HW               none | videotoolbox | nvenc | qsv | amf (absent or auto: pick what ffmpeg offers)

CPU: `jobs()` parallel ffmpeg processes of `ffmpeg_threads()` threads each never use more than
`cores()` processors together; `hf_workers()` x `hf_jobs()` is the same budget for HyperFrames.

GPU: no operating system limits a GPU share, so a GPU task (one hardware encode or decode, one
speech recognition run, one HyperFrames render) takes a slot first: `with gpu_slot(): ...`.
The slots are files so that programs in any language can take part; the protocol is in
`GpuSlots` below and in SPEC section 9.

Hardware: `video_encoder`, `audio_encoder` and `hwaccel_args` choose from what the machine's
ffmpeg lists (`ffmpeg -encoders`, parsed once), checked with a one-frame trial encode because a
Windows ffmpeg lists NVENC, Quick Sync and AMF whether or not the computer has that hardware.
"""
from __future__ import annotations

import contextlib
import json
import math
import os
import random
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from . import tools

# ---------------------------------------------------------------------------------- CPU


def cores() -> int:
    """Processors this job may use: VE_CPU_CORES, else every logical processor."""
    raw = os.environ.get("VE_CPU_CORES", "").strip()
    try:
        n = int(float(raw)) if raw else 0
    except ValueError:
        n = 0
    return n if n >= 1 else max(1, os.cpu_count() or 1)


def jobs() -> int:
    """Parallel ffmpeg processes: half of the cores (at least one, at most eight)."""
    return max(1, min(8, cores() // 2))


def ffmpeg_threads() -> int:
    """Threads per ffmpeg process, so that jobs() x ffmpeg_threads() stays within cores()."""
    return max(1, cores() // jobs())


def hf_workers() -> int:
    """HyperFrames capture workers (one headless Chrome each) for one render."""
    return max(1, cores() // 2)


def hf_jobs() -> int:
    """HyperFrames renders at the same time, so that hf_jobs() x hf_workers() stays within cores()."""
    return max(1, cores() // hf_workers())


def ffmpeg_thread_args() -> list[str]:
    """Output-side thread options.  Put them before the output file of every ffmpeg command
    that does real work (an option after the output file is an error)."""
    t = str(ffmpeg_threads())
    return ["-threads", t, "-filter_threads", t, "-filter_complex_threads", t]


def decode_args() -> list[str]:
    """Input-side options for a heavy decode: the hardware decoder if there is one, and the
    decoder's thread count.  Goes before `-i`."""
    return hwaccel_args() + ["-threads", str(ffmpeg_threads())]


# ---------------------------------------------------------------------------------- GPU slots

LEASE_S = 15 * 60       # a slot not renewed for this long is free to take over
RENEW_S = 60            # how often the holder renews it
POLL_S = 1.0            # how often a waiting program tries again


def pid_alive(pid: int) -> bool:
    """Whether a process with this id runs.  (os.kill(pid, 0) would kill it on Windows.)"""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32                                    # type: ignore[attr-defined]
        k32.OpenProcess.restype = wintypes.HANDLE
        handle = k32.OpenProcess(0x1000, False, pid)                    # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            return bool(k32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            k32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


class GpuSlots:
    """The GPU slot file protocol of SPEC section 9.

    <dir>/limits.json is {"total": n, "perJob": n}, read at every attempt.  A slot is the file
    slot-<i> (0 <= i < total) made with exclusive create and holding {"jobId", "pid", "at"}
    (milliseconds); the first name that can be made is the slot taken.  The holder sets the
    file's modified time every `renew_s` seconds.  A slot not renewed for `lease_s`, or whose
    process no longer runs, is taken over by renaming it to a unique name first and deleting
    that, so two programs never both believe they freed it.  This job never holds more than
    perJob slots.  Waiting programs try again every `poll_s`.
    Without limits.json the limits are one slot in all and one per job (safe, and the server
    rewrites the file whenever the settings change).
    """

    def __init__(self, directory, job_id, *, clock=time.time, sleep=time.sleep, alive=pid_alive,
                 lease_s=LEASE_S, renew_s=RENEW_S, poll_s=POLL_S, pid=None, log=None):
        self.dir = Path(directory)
        self.job_id = str(job_id)
        self.clock = clock
        self.sleep = sleep
        self.alive = alive
        self.lease_s = lease_s
        self.renew_s = renew_s
        self.poll_s = poll_s
        self.pid = os.getpid() if pid is None else pid
        self.log = log
        self._lock = threading.Lock()       # one decision at a time inside this process

    # -- reading
    def limits(self) -> tuple[int, int]:
        try:
            data = json.loads((self.dir / "limits.json").read_text(encoding="utf-8"))
            total = max(1, int(data["total"]))
            per_job = max(1, min(total, int(data["perJob"])))
            return total, per_job
        except (OSError, ValueError, KeyError, TypeError):
            return 1, 1

    def _read(self, path: Path):
        try:
            st = path.stat()
            data = json.loads(path.read_text(encoding="utf-8"))
            return st.st_mtime, data
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            # being written right now, or damaged: judge it by its age alone
            try:
                return path.stat().st_mtime, {}
            except OSError:
                return None

    def _stale(self, mtime, data) -> bool:
        if self.clock() - mtime > self.lease_s:
            return True
        pid = data.get("pid") if isinstance(data, dict) else None
        return isinstance(pid, int) and not self.alive(pid)

    def _mine(self, total) -> list[int]:
        """Indexes of the live slots of this job."""
        out = []
        for i in range(total):
            got = self._read(self.dir / f"slot-{i}")
            if got and isinstance(got[1], dict) and got[1].get("jobId") == self.job_id \
                    and not self._stale(*got):
                out.append(i)
        return out

    # -- taking
    def _take_over(self, path: Path, seen) -> bool:
        """Free a stale slot.  True when this program freed it."""
        aside = path.with_name(f"{path.name}.gone-{uuid.uuid4().hex}")
        try:
            os.rename(path, aside)
        except OSError:
            return False                          # someone else got there first
        got = self._read(aside)
        if got is not None and got[1] != seen[1] and not self._stale(*got):
            # we moved a fresh slot another program made after we looked: give it back
            try:
                os.link(aside, path)
            except OSError:
                pass
        with contextlib.suppress(OSError):
            os.unlink(aside)
        return True

    def _try_once(self):
        """One attempt.  Returns the path of the slot taken, or None."""
        with self._lock:
            total, per_job = self.limits()
            self.dir.mkdir(parents=True, exist_ok=True)
            if len(self._mine(total)) >= per_job:
                return None
            for i in range(total):
                path = self.dir / f"slot-{i}"
                got = self._read(path)
                if got is not None:
                    if not self._stale(*got):
                        continue
                    if not self._take_over(path, got):
                        continue
                body = json.dumps({"jobId": self.job_id, "pid": self.pid, "at": int(self.clock() * 1000)})
                try:
                    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
                except FileExistsError:
                    continue
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(body)
                # another program of the same job may have been taking a slot at the same moment
                if len(self._mine(total)) > per_job:
                    with contextlib.suppress(OSError):
                        os.unlink(path)
                    return None
                return path
            return None

    def acquire(self) -> "Held":
        said = False
        while True:
            path = self._try_once()
            if path is not None:
                return Held(self, path)
            if not said and self.log:
                self.log("waiting for a GPU slot")
                said = True
            self.sleep(self.poll_s + random.random() * self.poll_s * 0.1)

    @contextlib.contextmanager
    def slot(self):
        held = self.acquire()
        try:
            yield held
        finally:
            held.release()


class Held:
    """A slot taken: renewed by a daemon thread until released."""

    def __init__(self, owner: GpuSlots, path: Path):
        self.owner = owner
        self.path = path
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._renew, name="gpu-slot-renew", daemon=True)
        self._thread.start()

    def _renew(self):
        while not self._stop.wait(self.owner.renew_s):
            with contextlib.suppress(OSError):
                now = self.owner.clock()
                os.utime(self.path, (now, now))

    def release(self):
        self._stop.set()
        self._thread.join(timeout=2)
        got = self.owner._read(self.path)
        # only delete our own file: after a take-over the name may belong to somebody else
        if got is not None and isinstance(got[1], dict) and got[1].get("pid") == self.owner.pid \
                and got[1].get("jobId") == self.owner.job_id:
            with contextlib.suppress(OSError):
                os.unlink(self.path)


_depth = threading.local()


def _stderr(message: str) -> None:
    print(f"gpu: {message}", file=sys.stderr, flush=True)


@contextlib.contextmanager
def gpu_slot(*, slots: GpuSlots | None = None):
    """Hold one GPU slot for the duration of the block.

    Takes the environment the server gives a job (VE_GPU_SLOTS_DIR, VE_JOB_ID); without both it
    yields at once, which is how the toolkit runs by hand.  Nested use in one thread (a GPU task
    inside a GPU task) does not take a second slot.
    """
    if getattr(_depth, "n", 0) > 0:
        yield
        return
    if slots is None:
        directory, job_id = os.environ.get("VE_GPU_SLOTS_DIR"), os.environ.get("VE_JOB_ID")
        if not directory or not job_id:
            yield
            return
        slots = GpuSlots(directory, job_id, log=_stderr)
    _depth.n = 1
    try:
        with slots.slot():
            yield
    finally:
        _depth.n = 0


def gpu_task(*kinds: str):
    """`gpu_slot()` when the ffmpeg work for these encoder kinds (and decoding) uses the GPU,
    else a no-op: software encoding needs no slot."""
    if uses_gpu(*kinds):
        return gpu_slot()
    return contextlib.nullcontext()


# ---------------------------------------------------------------------------------- hardware

BACKENDS = ("videotoolbox", "nvenc", "qsv", "amf")      # tried in this order
ENCODER_NAMES = {
    "h264": {"videotoolbox": "h264_videotoolbox", "nvenc": "h264_nvenc", "qsv": "h264_qsv",
             "amf": "h264_amf", "software": "libx264"},
    "hevc": {"videotoolbox": "hevc_videotoolbox", "nvenc": "hevc_nvenc", "qsv": "hevc_qsv",
             "amf": "hevc_amf", "software": "libx265"},
    "prores": {"videotoolbox": "prores_videotoolbox", "software": "prores_ks"},
}
HWACCEL_NAMES = {"videotoolbox": "videotoolbox", "nvenc": "cuda", "qsv": "qsv", "amf": "d3d11va"}
_ENCODER_LINE = re.compile(r"^\s*[VAS][.\w]{5}\s+(\w+)\s")

_cache: dict = {}
_cache_lock = threading.Lock()


def reset_cache() -> None:
    """Forget what was learned about ffmpeg (tests, or after the environment changed)."""
    with _cache_lock:
        _cache.clear()


def _ffmpeg_text(*args: str) -> str:
    try:
        r = subprocess.run([tools.ffmpeg(), "-hide_banner", *args], capture_output=True, text=True, encoding="utf-8", errors="replace",
                           stdin=subprocess.DEVNULL, timeout=30)
        return r.stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _encoders_text() -> str:
    return _ffmpeg_text("-encoders")


def _hwaccels_text() -> str:
    return _ffmpeg_text("-hwaccels")


def parse_encoders(text: str) -> set[str]:
    """Encoder names in the output of `ffmpeg -hide_banner -encoders`."""
    return {m.group(1) for line in text.splitlines() if (m := _ENCODER_LINE.match(line))}


def encoders() -> set[str]:
    with _cache_lock:
        if "encoders" not in _cache:
            _cache["encoders"] = parse_encoders(_encoders_text())
        return _cache["encoders"]


def hwaccels() -> set[str]:
    with _cache_lock:
        if "hwaccels" not in _cache:
            lines = _hwaccels_text().splitlines()
            _cache["hwaccels"] = {ln.strip() for ln in lines[1:] if ln.strip()}
        return _cache["hwaccels"]


def _probe_args(name: str) -> list[str]:
    """The encoder options of the trial: the pixel format and profile the encoder is used with
    (`pix_fmt` and `video_encoder`), so an encoder that cannot do 10 bit HEVC is not chosen for it."""
    if name.startswith("prores"):
        return ["-pix_fmt", "yuv422p10le"]
    if name.startswith("hevc") or name.startswith("libx265"):
        return ["-pix_fmt", "p010le" if name != "libx265" else "yuv420p10le", "-profile:v", "main10"]
    return ["-pix_fmt", "nv12" if name.endswith(("_videotoolbox", "_qsv")) else "yuv420p"]


def _probe_encoder(name: str) -> bool:
    """Whether this encoder really starts here: a few tiny frames to the null muxer.
    What ffmpeg said when it did not is kept for `probe_error`."""
    key = ("probe-error", name)
    try:
        r = subprocess.run(
            [tools.ffmpeg(), "-hide_banner", "-v", "error", "-f", "lavfi", "-i",
             "color=black:s=256x256:r=25:d=0.2", "-frames:v", "2", *_probe_args(name), "-c:v", name,
             "-f", "null", "-"],
            capture_output=True, stdin=subprocess.DEVNULL, timeout=60)
        text = (r.stderr or b"").decode("utf-8", "replace").strip()
        error = None if r.returncode == 0 else (text.splitlines()[-1] if text else f"exit code {r.returncode}")
    except (OSError, subprocess.SubprocessError) as e:
        error = f"{type(e).__name__}: {e}"
    with _cache_lock:
        _cache[key] = error
    return error is None


def probe_error(name: str) -> str | None:
    """The last line ffmpeg printed when the trial of this encoder failed, else None."""
    with _cache_lock:
        return _cache.get(("probe-error", name))


def _forced() -> str:
    return os.environ.get("VE_HW", "").strip().lower()


def backend(kind: str) -> str:
    """'videotoolbox', 'nvenc', 'qsv', 'amf' or 'software': what encodes `kind` on this machine."""
    forced = _forced()
    key = ("backend", kind, forced)
    with _cache_lock:
        if key in _cache:
            return _cache[key]
    names = ENCODER_NAMES[kind]
    chosen = "software"
    if forced not in ("none", "software", "off"):
        have = encoders()
        order = [forced] if forced in BACKENDS else BACKENDS
        for b in order:
            name = names.get(b)
            if name and name in have and _probe_encoder(name):
                chosen = b
                break
    with _cache_lock:
        _cache[key] = chosen
    return chosen


def uses_gpu(*kinds: str) -> bool:
    """Whether encoding these kinds, or decoding, goes through the GPU here."""
    return any(backend(k) != "software" for k in kinds) or bool(hwaccel_args())


def video_encoder_name(kind: str) -> str:
    return ENCODER_NAMES[kind][backend(kind)]


def video_encoder(kind: str, *, profile: str | None = None, bitrate: str | None = None,
                  quality: int | None = None, gop: int | None = None) -> list[str]:
    """ffmpeg arguments that select and set up the video encoder for one use.

    kind     "prores" (profile "hq" or "standard"), "h264" (High profile for delivery, 8 bit)
             or "hevc" (Main 10, for screen recordings).
    bitrate  a target such as "40M" for h264 and hevc.
    quality  VideoToolbox's -q:v scale, only meaningful there (its bitrate control is loose);
             other encoders hold the bitrate, so callers calibrate only when `is_loose_rate()`.
    gop      keyframe distance in frames (hevc).
    """
    b = backend(kind)
    name = ENCODER_NAMES[kind][b]
    if kind == "prores":
        # prores_ks takes the same profile names; the picture is already 10 bit 4:2:2
        return ["-c:v", name, "-profile:v", profile or "standard"] + (["-vendor", "apl0"] if b == "software" else [])
    args = ["-c:v", name]
    pix = pix_fmt(kind)
    rate: list[str] = []
    if bitrate:
        rate = ["-b:v", bitrate]
        if kind == "h264":                  # delivery: hold the rate (hevc screen recordings just average it)
            rate += ["-maxrate", bitrate]
            if b not in ("videotoolbox", "qsv"):
                rate += ["-bufsize", f"{int(float(bitrate[:-1]) * 2)}{bitrate[-1]}"]
    if kind == "h264":
        args += ["-profile:v", "high"]
        if b == "nvenc":
            args += ["-preset", "p5", "-tune", "hq", "-rc", "vbr"]
        elif b == "amf":
            args += ["-quality", "quality", "-rc", "vbr_peak"]
        elif b == "software":
            args += ["-preset", "medium"]
        args += ["-pix_fmt", pix]
    else:
        args += ["-profile:v", "main10"]
        if b == "nvenc":
            args += ["-preset", "p5", "-rc", "vbr"]
        elif b == "software":
            args += ["-preset", "medium"]
        args += ["-tag:v", "hvc1"]
        if b == "videotoolbox":
            args += ["-allow_sw", "0"]
    if b == "videotoolbox" and quality is not None:
        args += ["-q:v", str(quality)]
    else:
        args += rate
        if b == "videotoolbox" and bitrate and kind == "h264":
            args += ["-constant_bit_rate", "1"]
    if gop:
        args += ["-g", str(gop)]
    return args


def describe_video() -> dict:
    """The video encoding of this machine for `ve.py doctor` and the System page:
    {"encoder": the h264 encoder, "hevc": the hevc encoder, "decoder": "cuda" | ... | "software",
     "hardware": bool, "failed": [{"encoder", "error"}]} where `failed` lists the hardware encoders that
    ffmpeg offers but that did not start here, with ffmpeg's last line."""
    failed = []
    if _forced() not in ("none", "software", "off"):
        have = encoders()
        for b in BACKENDS:
            for kind in ("h264", "hevc"):
                name = ENCODER_NAMES[kind].get(b)
                if name and name in have and backend(kind) != b:
                    err = probe_error(name)
                    if err:
                        failed.append({"encoder": name, "error": err})
    args = hwaccel_args()
    return {"encoder": video_encoder_name("h264"), "hevc": video_encoder_name("hevc"),
            "decoder": args[1] if len(args) > 1 else "software",
            "hardware": backend("h264") != "software", "failed": failed}


def pix_fmt(kind: str) -> str:
    """The pixel format the encoder of `kind` takes: 8 bit for h264, 10 bit for hevc."""
    b = backend(kind)
    if kind == "h264":
        return "nv12" if b in ("videotoolbox", "qsv") else "yuv420p"
    if kind == "hevc":
        return "yuv420p10le" if b == "software" else "p010le"
    return "yuv422p10le"


def is_loose_rate() -> bool:
    """True when the h264 encoder only treats -b:v as a ceiling (VideoToolbox), so a delivery
    bitrate has to be calibrated with `quality`."""
    return backend("h264") == "videotoolbox"


def audio_encoder_name() -> str:
    if _forced() in ("none", "software", "off"):
        return "aac"
    return "aac_at" if "aac_at" in encoders() else "aac"


def audio_encoder(bitrate: str = "320k") -> list[str]:
    """`aac_at` (AudioToolbox, macOS) when ffmpeg has it, else the built-in `aac`."""
    if audio_encoder_name() == "aac_at":
        return ["-c:a", "aac_at", "-aac_at_mode", "cbr", "-b:a", bitrate]
    return ["-c:a", "aac", "-b:a", bitrate]


def hwaccel_args() -> list[str]:
    """Decoder options for the hardware decoder of the chosen backend (before `-i`), or []."""
    forced = _forced()
    if forced in ("none", "software", "off"):
        return []
    b = backend("h264")
    name = HWACCEL_NAMES.get(b)
    if name and name in hwaccels():
        return ["-hwaccel", name]
    return []
