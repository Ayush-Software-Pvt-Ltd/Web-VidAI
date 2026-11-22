"""Speech recognition behind one function, whatever the machine is.

`mlx-whisper` on Apple Silicon (Apple GPU through MLX), `faster-whisper` everywhere else
(CUDA when ctranslate2 sees a GPU, else the CPU).  The packages are imported when first used,
so this module loads on a machine with neither.  Nothing else in the toolkit imports a
speech package.

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
import sys
import threading

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


def _cuda_available() -> bool:
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def device() -> str:
    """"gpu" (Apple GPU through MLX, or CUDA) or "cpu"."""
    if backend() == "mlx":
        return "gpu"
    forced = os.environ.get("VE_ASR_DEVICE", "").strip().lower()
    if forced in ("cpu", "cuda"):
        return "gpu" if forced == "cuda" else "cpu"
    return "gpu" if _cuda_available() else "cpu"


def gpu_task():
    """A GPU slot for the duration of a run that uses the GPU, else a no-op."""
    return resources.gpu_slot() if device() == "gpu" else contextlib.nullcontext()


def _faster_model(name: str):
    dev = "cuda" if device() == "gpu" else "cpu"
    key = (name, dev)
    with _faster_lock:
        if key not in _faster_models:
            from faster_whisper import WhisperModel
            _faster_models[key] = WhisperModel(
                name, device=dev, compute_type="float16" if dev == "cuda" else "int8",
                cpu_threads=resources.cores() if dev == "cpu" else 0)
        return _faster_models[key]


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
