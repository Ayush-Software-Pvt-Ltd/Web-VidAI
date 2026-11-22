"""Print word timestamps in a raw-time window, for picking cut points.

Usage: python words.py <video folder> <part> <t0> <t1> [--full]
Words come from <part>.chunks.json (or <part>.full.json with --full) and print
as start|word|end, one line per chunk.
"""
import json
import sys

from vekit.paths import project_dir


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    proj, part, t0, t1 = project_dir(args[0]), args[1], float(args[2]), float(args[3])
    tdir = proj / "transcripts"
    if "--full" in sys.argv:
        words = json.loads((tdir / f"{part}.full.json").read_text(encoding="utf-8"))["words"]
        groups = [words]
    else:
        groups = [c["words"] for c in json.loads((tdir / f"{part}.chunks.json").read_text(encoding="utf-8"))["chunks"]]
    for g in groups:
        sel = [w for w in g if w["e"] > t0 and w["s"] < t1]
        if sel:
            print("  ".join(f"{w['s']:.2f}|{w['w']}|{w['e']:.2f}" for w in sel))
            print()


if __name__ == "__main__":
    main()
