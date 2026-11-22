"""Re-transcribe short raw-time windows of an A-roll (one Whisper model load for all).

Whisper loops ("iPhone 16, iPhone 16, ...") on long retake-heavy chunks; the same audio
transcribed in pieces of a few seconds, each with 0.3 s of silence in front, comes out clean.
Windows longer than --max are split at energy valleys first.

Usage:
  python windows.py <audio_16k.wav> <out.json> 63.4-73.7 92-99 ... [--max 4.5] [--prompt "..."] [--lang hi]
Prints start|word|end per piece and writes {"pieces": [{"s", "e", "text", "words"}]}.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from transcribe import DEFAULT_PROMPT, MODELS, SR  # noqa: E402
from vekit import asr  # noqa: E402


def split(audio, a, b, max_len):
    """[(a, b)] cut at the quietest 50 ms point of the middle 40 % until pieces fit max_len."""
    out, stack = [], [(a, b)]
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("out")
    ap.add_argument("windows", nargs="+", help="raw seconds as t0-t1")
    ap.add_argument("--max", type=float, default=4.5)
    ap.add_argument("--model", default="large-v3", choices=MODELS)
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--lang", default="hi")
    a = ap.parse_args()
    prompt = a.prompt if a.prompt is not None else (DEFAULT_PROMPT if a.lang == "hi" else None)
    audio, sr = sf.read(a.wav, dtype="float32")
    assert sr == SR, "expects 16 kHz mono"
    pad = np.zeros(int(0.3 * SR), dtype="float32")
    pieces = []
    with asr.gpu_task():                   # one GPU slot and one model load for all windows
        for w in a.windows:
            t0, t1 = (float(x) for x in w.split("-"))
            for s, e in split(audio, t0, t1, a.max):
                clip = np.concatenate([pad, audio[int(s * SR):int(e * SR)]])
                r = asr.transcribe(clip, model=a.model, language=a.lang, prompt=prompt, offset=s - 0.3)
                words = r["words"]
                pieces.append({"s": round(s, 3), "e": round(e, 3), "text": r["text"], "words": words})
                print(f"{s:7.2f}-{e:7.2f}  {r['text']}", flush=True)
                print("   " + "  ".join(f"{x['s']:.2f}|{x['w']}|{x['e']:.2f}" for x in words), flush=True)
    Path(a.out).write_text(json.dumps({"pieces": pieces}, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
