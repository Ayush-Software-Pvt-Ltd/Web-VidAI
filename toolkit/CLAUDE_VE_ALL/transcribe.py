"""A-roll transcription with word timestamps (mlx-whisper or faster-whisper, see vekit/asr.py).

Two passes, both kept (each recovers words the other misses):
  full    one pass over the whole file                -> <out>/<part>.full.json
  chunks  speech chunks split on silences, each
          transcribed alone (no carried context, so
          repetition loops cannot spread)             -> <out>/<part>.chunks.json

Usage:
  python transcribe.py <audio_16k.wav> <out_dir> <part> [--pass full|chunks|both]
                       [--model large-v3|turbo] [--prompt "..."] [--lang hi|en|auto|...]

--lang is a Whisper language code (default hi).  --lang auto detects the spoken language once on
windows spread over the audio, prints it with its probability, and uses it for every pass and chunk;
the Hindi tech prompt is used only when the language is hi.  `ve.py lang <video folder>` only detects.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vekit import asr, tools  # noqa: E402

MODELS = list(asr.MODELS)
DEFAULT_PROMPT = (
    "दोस्तों, आज हम इस product के बारे में बात करेंगे - features, price, "
    "battery, mAh, fast charging, USB-C, Type-C, W, GB, iPhone, Android, Samsung, app."
)
SR = 16000


def silences(wav, noise_db=-38, min_dur=0.35):
    out = subprocess.run(
        [tools.ffmpeg(), "-hide_banner", "-i", str(wav), "-af",
         f"silencedetect=n={noise_db}dB:d={min_dur}", "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
    starts = [float(v) for v in re.findall(r"silence_start: ([\d.]+)", out)]
    ends = [float(v) for v in re.findall(r"silence_end: ([\d.]+)", out)]
    return list(zip(starts, ends))


def speech_chunks(wav, total, max_len=25.0):
    """Speech regions between silences, split further so none exceeds max_len."""
    sil = silences(wav)
    chunks, t = [], 0.0
    for s, e in sil:
        if s - t > 0.15:
            chunks.append((max(0.0, t - 0.1), min(total, s + 0.1)))
        t = e
    if total - t > 0.15:
        chunks.append((max(0.0, t - 0.1), total))
    # split long chunks at their quietest point near the middle
    audio, _ = sf.read(str(wav))
    out = []
    for a, b in chunks:
        stack = [(a, b)]
        while stack:
            a, b = stack.pop(0)
            if b - a <= max_len:
                out.append((a, b))
                continue
            lo, hi = a + (b - a) * 0.3, a + (b - a) * 0.7
            seg = audio[int(lo * SR):int(hi * SR)]
            win = int(0.05 * SR)
            rms = np.sqrt(np.convolve(seg ** 2, np.ones(win) / win, mode="valid"))
            cut = lo + int(np.argmin(rms)) / SR + 0.025
            stack[:0] = [(a, cut), (cut, b)]
    return out


def resolve_language(lang, audio, model):
    """`auto` becomes the detected language code (printed with its probability, detected once so
    every pass and chunk uses the same one); any other value is returned as it is."""
    if lang != "auto":
        return lang
    found = asr.detect_language(audio, model=model)
    print(asr.describe_language(found), flush=True)
    return found["language"]


def run(model, audio, prompt, lang="hi", offset=0.0):
    """One recognition: {"text", "segments": [{s, e, text}], "words": [{w, s, e, p}]}."""
    return asr.transcribe(audio, model=model, language=lang, prompt=prompt, offset=offset)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("out")
    ap.add_argument("part")
    ap.add_argument("--pass", dest="which", default="both", choices=["full", "chunks", "both"])
    ap.add_argument("--model", default="large-v3", choices=list(MODELS))
    ap.add_argument("--prompt", default=None, help="initial prompt (default: a Hindi tech prompt for hi)")
    ap.add_argument("--lang", default="hi", help="Whisper language code (hi, en, ...) or auto to detect it")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    audio, sr = sf.read(a.wav, dtype="float32")
    assert sr == SR, "expects 16 kHz mono"
    total = len(audio) / SR

    # one GPU slot for the whole run (SPEC section 9): the model stays loaded between the passes
    with asr.gpu_task():
        a.lang = resolve_language(a.lang, audio, a.model)
        if a.prompt is None and a.lang == "hi":
            a.prompt = DEFAULT_PROMPT
        if a.which in ("full", "both"):
            r = run(a.model, a.wav, a.prompt, a.lang)
            (out / f"{a.part}.full.json").write_text(json.dumps(
                {"model": a.model, "language": a.lang, "segments": r["segments"], "words": r["words"]},
                ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"full pass: {len(r['segments'])} segments", flush=True)

        if a.which in ("chunks", "both"):
            chunks = speech_chunks(a.wav, total)
            res = []
            for i, (s, e) in enumerate(chunks):
                r = run(a.model, audio[int(s * SR):int(e * SR)], a.prompt, a.lang, offset=s)
                res.append({"i": i, "s": round(s, 3), "e": round(e, 3), "text": r["text"],
                            "words": r["words"]})
                print(f"[{i + 1}/{len(chunks)}] {s:7.2f}-{e:7.2f} {r['text']}", flush=True)
            (out / f"{a.part}.chunks.json").write_text(json.dumps(
                {"model": a.model, "language": a.lang, "chunks": res}, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(asr.guarded(main))
