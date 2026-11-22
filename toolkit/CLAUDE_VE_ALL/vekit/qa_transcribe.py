"""Re-transcribe an edited mix to catch clipped words and leftover retake fragments.

Usage: python <toolkit>/CLAUDE_VE_ALL/vekit/qa_transcribe.py <mix.wav> [--window 20] [--out file.txt] [--lang hi|en]
Whisper stops after ~30 s per call and loops on short quiet windows, so the mix is cut
into ~20 s windows on quiet points and each is transcribed alone.  Printed with output
times so suspicious junctions can be found on the timeline.
"""
import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vekit import asr, tools  # noqa: E402

SR = 16000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mix")
    ap.add_argument("--window", type=float, default=20.0)
    ap.add_argument("--out")
    ap.add_argument("--lang", default="hi", help="Whisper language code (hi, en, ...)")
    a = ap.parse_args()
    raw = subprocess.run([tools.ffmpeg(), "-v", "error", "-i", a.mix, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    hop = SR // 100
    n = len(x) // hop
    db = 20 * np.log10(np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1)) + 1e-9)
    lines, t = [], 0.0
    total = len(x) / SR
    with asr.gpu_task():
        while t < total - 0.2:
            end = min(total, t + a.window)
            if end < total:                                  # cut at the quietest 50 ms near the window end
                lo, hi = int((end - 4) * 100), int(end * 100)
                end = (lo + int(np.argmin(np.convolve(db[lo:hi], np.ones(5) / 5, mode="same")))) / 100
            r = asr.transcribe(x[int(t * SR):int(end * SR)], model="large-v3", language=a.lang, offset=t)
            for s in r["segments"]:
                lines.append(f"{s['s']:7.2f}-{s['e']:7.2f}  {s['text']}")
            t = end
    text = "\n".join(lines)
    print(text)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")


if __name__ == "__main__":
    sys.exit(asr.guarded(main))
