"""Synthesise the subtle SFX set (seeded, so it is reproducible) and write manifest.json.

  whoosh1-3  filtered-noise sweeps, peak near 0.18 s (aligned to the cut by the planner)
  pop1-2     short pitch-dropping sine blips with a soft click (keyword hits)
  tick       tiny high click (checklists)
All files: 48 kHz stereo 24-bit WAV, peak -3 dBFS.  Run: python make_sfx.py
"""
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

SR = 48000
OUT = Path(__file__).resolve().parent


def norm(x, peak_db=-3.0):
    return x / (np.abs(x).max() + 1e-9) * 10 ** (peak_db / 20)


def stereo(x, width=0.0, seed=0):
    if width <= 0:
        return np.stack([x, x], axis=1)
    d = int(width * SR / 1000)
    return np.stack([x, np.concatenate([np.zeros(d), x[:-d]])], axis=1)


def whoosh(seed, dur=0.55, peak=0.18, f_lo=300, f_hi=4500):
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    # amplitude: fast rise to the peak, smooth decay
    env = np.where(t < peak, (t / peak) ** 2.2, np.exp(-(t - peak) / (dur * 0.28)))
    # sweep a band-pass centre up then down through the noise in short blocks
    out = np.zeros(n)
    block = 512
    zi = None
    for s in range(0, n, block):
        tc = t[min(s, n - 1)]
        k = np.clip(tc / peak, 0, 1) if tc < peak else np.clip(1 - (tc - peak) / (dur - peak), 0, 1)
        fc = f_lo * (f_hi / f_lo) ** k
        sos = butter(2, [fc / 1.6, min(fc * 1.6, SR / 2 - 100)], btype="band", fs=SR, output="sos")
        seg = noise[s:s + block]
        if zi is None:
            zi = np.zeros((sos.shape[0], 2))
        y, zi = sosfilt(sos, seg, zi=zi)
        out[s:s + block] = y
    x = norm(out * env)
    return stereo(x, width=0.35), peak


def pop(seed, f0=880, f1=420, dur=0.16):
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.03)
    phase = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(phase) * np.exp(-t / 0.045)
    click = rng.standard_normal(n) * np.exp(-t / 0.002) * 0.3
    att = np.clip(t / 0.002, 0, 1)
    return stereo(norm((body + click) * att)), 0.004


def tick(seed):
    rng = np.random.default_rng(seed)
    n = int(0.05 * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * 2400 * t) * np.exp(-t / 0.008) + rng.standard_normal(n) * np.exp(-t / 0.0015) * 0.2
    return stereo(norm(x)), 0.002


def main():
    items = {
        "whoosh1": whoosh(101),
        "whoosh2": whoosh(202, dur=0.5, peak=0.16, f_lo=250, f_hi=3800),
        "whoosh3": whoosh(303, dur=0.6, peak=0.2, f_lo=350, f_hi=5200),
        "pop1": pop(11),
        "pop2": pop(22, f0=1040, f1=520),
        "tick": tick(5),
    }
    manifest = {}
    for name, (x, peak) in items.items():
        sf.write(OUT / f"{name}.wav", x.astype(np.float32), SR, subtype="PCM_24")
        manifest[name] = {"samples": len(x), "peak": peak}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
