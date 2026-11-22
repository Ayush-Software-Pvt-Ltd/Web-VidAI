"""Speech recognition behind one function, whatever the machine is.

`mlx-whisper` on Apple Silicon (Apple GPU through MLX), `faster-whisper` everywhere else
(CUDA when it really works, else the CPU).  The packages are imported when first used,
so this module loads on a machine with neither.  Nothing else in the toolkit imports a
speech package.

CUDA needs the cuBLAS and cuDNN libraries of CUDA 12.  The server installs them into the
toolkit's environment (`requirements-cuda.txt`, pip wheels `nvidia-*-cu12`) when the machine has
an NVIDIA GPU; the wheels keep their DLLs in `site-packages/nvidia/<library>/bin` (Windows) or
`.../lib` (Linux), where nothing looks, so `register_cuda_libraries()` makes them findable
before ctranslate2 is imported.  The device is decided once per process (`cuda_status()`): CUDA whenever the machine has an
NVIDIA GPU (or ctranslate2 sees a CUDA device), the CPU only on a machine without one or when
VE_ASR_DEVICE=cpu says so (an administrator's or a test's override, never an agent's).  There is no
quiet fallback: on an NVIDIA machine a missing library or a failed first run (the encoder runs
once on a second of silence) stops with `SpeechDeviceError`, one plain line that names what is
missing and says the administrator repairs it with Prepare on the System page.  The server's
Prepare installs the libraries and proves the device, so a run normally never meets this.

Both backends give the same result:

  {"text": "...",
   "segments": [{"s": 0.0, "e": 3.2, "text": "..."}],
   "words":    [{"w": "word", "s": 0.12, "e": 0.40, "p": 0.98}]}

Times are seconds from the start of the audio plus `offset`; the options are fixed to what the
edit relies on: temperature 0, no conditioning on earlier text (a repetition loop cannot
spread), word timestamps.

A recognition run is a GPU task when it runs on the GPU: callers wrap the run in
`with asr.gpu_task():` (SPEC section 9).  Memory is not checked here: the server limits how
many jobs run at once, and a free-memory check cannot be made portable without new packages.
"""
from __future__ import annotations

import contextlib
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from . import resources

# toolkit model name -> model of each backend
MODELS = {
    "large-v3": {"mlx": "mlx-community/whisper-large-v3-mlx", "faster": "large-v3"},
    "turbo": {"mlx": "mlx-community/whisper-large-v3-turbo", "faster": "large-v3-turbo"},
}

_faster_models: dict = {}
_faster_lock = threading.Lock()


def backend() -> str:
    """"mlx" on Apple Silicon, else "faster".  VE_ASR_BACKEND=mlx|faster forces one."""
    forced = os.environ.get("VE_ASR_BACKEND", "").strip().lower()
    if forced in ("mlx", "faster"):
        return forced
    if sys.platform == "darwin" and platform.machine().lower() in ("arm64", "aarch64"):
        return "mlx"
    return "faster"


def model_name(model: str, which: str | None = None) -> str:
    """The backend's name for a toolkit model name ("large-v3", "turbo")."""
    if model not in MODELS:
        raise ValueError(f"unknown speech model {model!r}; choose one of {', '.join(MODELS)}")
    return MODELS[model][which or backend()]


# ---------------------------------------------------------------------------------- CUDA

# The libraries ctranslate2 4.x (built for CUDA 12) loads: cuBLAS 12 at the first matrix
# product, cuDNN 9 (the main library, then its parts, lazily) at the first convolution.
CUDA_LIBRARIES = {
    "win32": ("cublas64_12.dll", "cublasLt64_12.dll", "cudnn64_9.dll", "cudnn_ops64_9.dll",
              "cudnn_cnn64_9.dll"),
    "linux": ("libcublas.so.12", "libcublasLt.so.12", "libcudnn.so.9"),
}

_status_lock = threading.RLock()
_status: dict | None = None
_registered: list | None = None
_dll_handles: list = []


def reset() -> None:
    """Forget the decisions of this process (tests)."""
    global _status, _registered
    with _status_lock:
        _status = None
        _registered = None
        _dll_handles.clear()
    with _faster_lock:
        _faster_models.clear()


def _is_windows() -> bool:
    return sys.platform == "win32"


def nvidia_library_dirs() -> list[Path]:
    """The `nvidia/<library>/bin` (Windows) or `lib` folders of the pip wheels, from sys.path."""
    sub = "bin" if _is_windows() else "lib"
    found: list[Path] = []
    for entry in sys.path:
        try:
            root = Path(entry or ".") / "nvidia"
            if not root.is_dir():
                continue
            for lib in sorted(root.iterdir()):
                d = lib / sub
                if d.is_dir() and d not in found:
                    found.append(d)
        except OSError:
            continue
    return found


def register_cuda_libraries() -> list[Path]:
    """Make the CUDA libraries of the pip wheels findable by this process, once.

    Windows: `os.add_dll_directory` for the DLLs ctranslate2 loads at import, and PATH for the
    ones it loads later by name (cuDNN).  Linux: the loader ignores a changed LD_LIBRARY_PATH in a
    running process, so the libraries are loaded here with global symbols, cuBLAS first.
    Returns the folders.  Safe to call again."""
    global _registered
    with _status_lock:
        if _registered is not None:
            return _registered
        dirs = nvidia_library_dirs()
        if _is_windows():
            for d in dirs:
                try:
                    _dll_handles.append(os.add_dll_directory(str(d)))
                except (OSError, AttributeError):
                    pass
            if dirs:
                os.environ["PATH"] = os.pathsep.join(
                    [str(d) for d in dirs] + [os.environ.get("PATH", "")])
        else:
            import ctypes
            names = [n for n in CUDA_LIBRARIES["linux"]]
            for d in dirs:
                names += sorted(p.name for p in d.glob("libcudnn_*.so.9"))
            for name in names:
                for d in dirs:
                    if (d / name).is_file():
                        try:
                            ctypes.CDLL(str(d / name), mode=ctypes.RTLD_GLOBAL)
                        except OSError:
                            pass
                        break
        _registered = dirs
        return dirs


def _library_found(name: str) -> bool:
    """Whether the loader would find this library: Windows looks in PATH (which
    `register_cuda_libraries` extended), Linux asks the loader."""
    if _is_windows():
        return any(d and os.path.isfile(os.path.join(d, name))
                   for d in os.environ.get("PATH", "").split(os.pathsep))
    import ctypes
    try:
        ctypes.CDLL(name)
        return True
    except OSError:
        return False


def missing_cuda_libraries() -> list[str]:
    """Names of the CUDA libraries ctranslate2 needs that cannot be found (empty: all there)."""
    wanted = CUDA_LIBRARIES.get("win32" if _is_windows() else "linux", ())
    return [n for n in wanted if not _library_found(n)]


def nvidia_gpu_name() -> str | None:
    """The name of the first NVIDIA GPU the driver reports (`nvidia-smi`), or None."""
    exe = shutil.which("nvidia-smi")
    if exe is None and _is_windows():
        root = os.environ.get("SystemRoot") or os.environ.get("SYSTEMROOT") or r"C:\Windows"
        for cand in (Path(root) / "System32" / "nvidia-smi.exe",
                     Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "NVIDIA Corporation"
                     / "NVSMI" / "nvidia-smi.exe"):
            if cand.is_file():
                exe = str(cand)
                break
    if exe is None:
        return None
    try:
        r = subprocess.run([exe, "--query-gpu=name", "--format=csv,noheader"], capture_output=True,
                           text=True, stdin=subprocess.DEVNULL, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    lines = [ln.strip() for ln in r.stdout.splitlines() if ln.strip()] if r.returncode == 0 else []
    return lines[0] if lines else None


def _cuda_device_count() -> int:
    try:
        import ctranslate2
        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


def _one_line(error: BaseException) -> str:
    text = " ".join(str(error).split()) or type(error).__name__
    return text if len(text) <= 240 else text[:237] + "..."


class SpeechDeviceError(RuntimeError):
    """The GPU of this computer cannot be used for speech recognition; the message is one line."""


def _problem_line(what: str) -> str:
    return (f"speech: the NVIDIA GPU cannot be used for speech recognition ({what}). The CPU is "
            f"not used instead. Ask the administrator to press Prepare on the System page of VidAI "
            f"Server, which installs what is missing; do not work around this in the edit.")


def cuda_status() -> dict:
    """What decides the device of this process, once: {"device": "cuda"|"cpu", "problem": str|None,
    "nvidia": str|None, "forced": bool}.  "cuda" with a `problem` means the machine has an NVIDIA
    GPU that cannot be used yet; "cpu" means there is none (or VE_ASR_DEVICE=cpu)."""
    global _status
    with _status_lock:
        forced = os.environ.get("VE_ASR_DEVICE", "").strip().lower()
        if _status is not None and _status["key"] == forced:
            return _status
        if forced == "cpu":
            _status = {"device": "cpu", "problem": None, "nvidia": None, "forced": True, "key": forced}
        elif forced == "cuda":
            register_cuda_libraries()
            _status = {"device": "cuda", "problem": None, "nvidia": nvidia_gpu_name(), "forced": True,
                       "key": forced}
        else:
            register_cuda_libraries()
            nvidia = nvidia_gpu_name()
            count = _cuda_device_count()
            if nvidia is None and count == 0:
                _status = {"device": "cpu", "problem": None, "nvidia": None, "forced": False,
                           "key": forced}
            else:
                problem = None
                missing = missing_cuda_libraries()
                if missing:
                    problem = f"these CUDA libraries were not found: {', '.join(missing)}"
                elif count == 0:
                    problem = ("ctranslate2 sees no CUDA device; the NVIDIA driver may be too old "
                               "or the faster-whisper packages are not installed")
                _status = {"device": "cuda", "problem": problem, "nvidia": nvidia, "forced": False,
                           "key": forced}
        return _status


def device() -> str:
    """"gpu" (Apple GPU through MLX, or CUDA) or "cpu"."""
    if backend() == "mlx":
        return "gpu"
    return "gpu" if cuda_status()["device"] == "cuda" else "cpu"


def describe() -> dict:
    """The speech device for `ve.py doctor` and the System page: {"backend", "device": "gpu"|"cpu",
    "summary", "problem": None | a sentence with what is wrong and how to fix it}."""
    which = backend()
    if which == "mlx":
        return {"backend": which, "device": "gpu", "summary": "Apple GPU (MLX)", "problem": None}
    st = cuda_status()
    if st["device"] != "cuda":
        return {"backend": which, "device": "cpu",
                "summary": "CPU (VE_ASR_DEVICE=cpu)" if st["forced"] else "CPU (no NVIDIA GPU)",
                "problem": None}
    name = f" ({st['nvidia']})" if st.get("nvidia") else ""
    if st["problem"]:
        return {"backend": which, "device": "gpu", "summary": f"GPU (CUDA){name}, not usable yet",
                "problem": f"{st['problem']}. Press Prepare to install what is missing."}
    return {"backend": which, "device": "gpu", "summary": f"GPU (CUDA){name}", "problem": None}


def gpu_task():
    """A GPU slot for the duration of a run that uses the GPU, else a no-op."""
    return resources.gpu_slot() if device() == "gpu" else contextlib.nullcontext()


def _verify_cuda(model) -> None:
    """Run the encoder once on a second of silence: this is where a missing cuBLAS, cuDNN or a
    GPU the library has no code for shows up."""
    import numpy as np
    segments, _info = model.transcribe(np.zeros(16000, dtype="float32"), language="en", beam_size=1,
                                       without_timestamps=True, condition_on_previous_text=False)
    for _ in segments:
        pass


def _error_text(error: BaseException) -> str:
    lib = re.search(r"(cublas\w*|cudnn\w*|cudart\w*|nvrtc\w*)[\w.]*\.(?:dll|so[\d.]*)", str(error), re.I)
    return f"library {lib.group(0)} is missing or too old" if lib else _one_line(error)


def _faster_model(name: str):
    st = cuda_status()          # also makes the CUDA libraries findable, before ctranslate2 loads
    from faster_whisper import WhisperModel
    dev = "cuda" if st["device"] == "cuda" else "cpu"
    with _faster_lock:
        if (name, dev) in _faster_models:
            return _faster_models[(name, dev)]
        if dev == "cpu":
            model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=resources.cores())
        else:
            if st["problem"]:                     # loading cuDNN that is not there can abort the process
                raise SpeechDeviceError(_problem_line(st["problem"]))
            try:
                model = WhisperModel(name, device="cuda", compute_type="float16")
                _verify_cuda(model)
            except Exception as e:
                raise SpeechDeviceError(_problem_line(_error_text(e))) from e
        _faster_models[(name, dev)] = model
        return model


def guarded(main):
    """Run a command's `main`; a speech device problem ends it with its one line and exit code 2
    instead of a traceback."""
    try:
        return main()
    except SpeechDeviceError as e:
        print(e, file=sys.stderr, flush=True)
        return 2


def warm_up(model: str = "large-v3") -> str:
    """Load the model on the device this machine uses and prove it works (Prepare calls this so
    that a broken GPU shows on the System page, not in an edit).  Returns `describe()["summary"]`;
    raises `SpeechDeviceError`.  The CPU is not loaded: nothing can fail there that a run would not show."""
    info = describe()
    if backend() == "faster" and info["device"] == "gpu":
        _faster_model(model_name(model, "faster"))
    return info["summary"]


def _from_mlx(result: dict, offset: float) -> dict:
    """mlx-whisper: {"segments": [{"start", "end", "text", "words": [{"word", "start", "end", "probability"}]}]}"""
    segments, words = [], []
    for seg in result.get("segments", []):
        segments.append({"s": round(seg["start"] + offset, 3), "e": round(seg["end"] + offset, 3),
                         "text": seg["text"].strip()})
        for w in seg.get("words", []) or []:
            words.append({"w": w["word"].strip(), "s": round(w["start"] + offset, 3),
                          "e": round(w["end"] + offset, 3), "p": round(float(w.get("probability", 0)), 3)})
    return {"text": " ".join(s["text"] for s in segments).strip(), "segments": segments, "words": words}


def _from_faster(segments, offset: float) -> dict:
    """faster-whisper: an iterator of objects with .start .end .text and .words (.word .start .end .probability)"""
    out_segments, words = [], []
    for seg in segments:
        out_segments.append({"s": round(seg.start + offset, 3), "e": round(seg.end + offset, 3),
                             "text": seg.text.strip()})
        for w in getattr(seg, "words", None) or []:
            words.append({"w": w.word.strip(), "s": round(w.start + offset, 3),
                          "e": round(w.end + offset, 3), "p": round(float(w.probability or 0), 3)})
    return {"text": " ".join(s["text"] for s in out_segments).strip(), "segments": out_segments,
            "words": words}


def transcribe(audio, *, model: str = "large-v3", language: str | None = "hi",
               prompt: str | None = None, offset: float = 0.0) -> dict:
    """Recognise speech in `audio` (a file path, or a float32 numpy array at 16 kHz mono)."""
    which = backend()
    name = model_name(model, which)
    if hasattr(audio, "__fspath__"):
        audio = os.fspath(audio)
    if which == "mlx":
        import mlx_whisper
        result = mlx_whisper.transcribe(
            audio, path_or_hf_repo=name, language=language, task="transcribe",
            word_timestamps=True, temperature=0.0, condition_on_previous_text=False,
            initial_prompt=prompt, verbose=None)
        return _from_mlx(result, offset)
    segments, _info = _faster_model(name).transcribe(
        audio, language=language, task="transcribe", word_timestamps=True, temperature=0.0,
        condition_on_previous_text=False, initial_prompt=prompt)
    return _from_faster(segments, offset)


# ------------------------------------------------------------------------------- language

SAMPLE_RATE = 16000
WINDOW_SECONDS = 30                  # Whisper listens to 30 s per language guess
SILENT_RMS = 0.003                   # a window quieter than this (about -50 dB) says nothing about the language


def _detection_windows(audio, count: int) -> list:
    """Up to `count` windows of 30 s spread over the audio (one when it is shorter), the silent
    ones left out unless all are silent.  The first seconds of a raw take are often crew chatter,
    so the windows are centred in equal parts of the audio instead of starting at 0."""
    import numpy as np
    size = WINDOW_SECONDS * SAMPLE_RATE
    if len(audio) <= size:
        return [audio]
    count = max(1, min(count, len(audio) // size))
    starts = [round((len(audio) - size) * (i + 0.5) / count) for i in range(count)]
    windows = [audio[s:s + size] for s in starts]
    loud = [w for w in windows if float(np.sqrt(np.mean(np.square(w, dtype="float64")))) >= SILENT_RMS]
    return loud or windows


def _language_probs(window, name: str, which: str) -> dict:
    """{language code: probability} of one window of at most 30 s."""
    if which == "mlx":
        import mlx.core as mx
        from mlx_whisper.audio import N_FRAMES, N_SAMPLES, log_mel_spectrogram, pad_or_trim
        from mlx_whisper.transcribe import ModelHolder
        model = ModelHolder.get_model(name, mx.float16)
        mel = log_mel_spectrogram(window, n_mels=model.dims.n_mels, padding=N_SAMPLES)
        _, probs = model.detect_language(pad_or_trim(mel, N_FRAMES, axis=-2).astype(mx.float16))
        return dict(probs[0] if isinstance(probs, list) else probs)
    _language, _probability, all_probs = _faster_model(name).detect_language(window)
    return dict(all_probs)


def detect_language(audio, *, model: str = "large-v3", windows: int = 3) -> dict:
    """The language spoken in `audio` (a float32 numpy array at 16 kHz mono): Whisper's guess on up
    to `windows` windows of 30 s spread over the audio, the probabilities averaged.
    Returns {"language": "hi", "probability": 0.93, "top": [("hi", 0.93), ("en", 0.05), ("ur", 0.01)]}.
    Callers wrap the run in `with asr.gpu_task():`."""
    which = backend()
    name = model_name(model, which)
    total: dict = {}
    parts = _detection_windows(audio, windows)
    for window in parts:
        for code, p in _language_probs(window, name, which).items():
            total[code] = total.get(code, 0.0) + float(p) / len(parts)
    if not total:
        raise RuntimeError("the speech model gave no language probabilities")
    top = sorted(total.items(), key=lambda kv: -kv[1])[:3]
    return {"language": top[0][0], "probability": round(top[0][1], 3),
            "top": [(code, round(p, 3)) for code, p in top]}


def describe_language(found: dict) -> str:
    """One line for the agent: `language: hi 0.93 (en 0.05, ur 0.01)`."""
    rest = ", ".join(f"{code} {p:.2f}" for code, p in found["top"][1:])
    return f"language: {found['language']} {found['probability']:.2f}" + (f" ({rest})" if rest else "")
