"""Per-video timing log -> <MAIN>/info.txt.

  python timing.py <MAIN> start transcription
  python timing.py <MAIN> end   transcription
  python timing.py <MAIN> start plan          # "transcription to edit plan"
  python timing.py <MAIN> end   plan
  python timing.py <MAIN> start review        # "edit plan to review file"
  python timing.py <MAIN> end   review
  python timing.py <MAIN> start render        # final 4K render, only after approval
  python timing.py <MAIN> end   render
  python timing.py <MAIN> pause | resume      # around time spent waiting for the creator
  python timing.py <MAIN> note "text"
  python timing.py <MAIN> write

Waiting time (between `pause` and `resume`) never counts.  `active` time also stops while no
step is open, so a session that idles overnight does not inflate the total.
"""
import argparse
import json
import struct
import sys
import time
from datetime import datetime
from pathlib import Path

from vekit.paths import project_dir, video_dir

# step id -> label used in info.txt (the four required by the brief come first)
LABELS = {
    "transcription": "1. Transcription",
    "plan": "2. Transcription to written edit plan",
    "review": "3. Edit plan to review project (FCP / Premiere)",
    "render": "4. Final 4K render",
    "setup": "   Setup and media recon",
    "graphics": "   Graphics build and render",
    "broll": "   B-roll conform and stabilisation",
    "qa": "   QA passes (frames, audio, composites)",
    "deliver": "   Thumbnails and meta",
}
ORDER = list(LABELS)


def load(main):
    p = project_dir(main) / "timing.json"
    if p.exists():
        return p, json.loads(p.read_text(encoding="utf-8"))
    return p, {"created": time.time(), "events": [], "notes": []}


def save(path, d):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(d, indent=1), encoding="utf-8")


def summarise(d):
    """-> (active seconds, {step: seconds}) walking the event log."""
    events = sorted(d["events"], key=lambda e: e["t"])
    active, open_steps, paused, last = 0.0, {}, False, None
    for e in events:
        if last is not None and not paused and open_steps:
            active += e["t"] - last
        last = e["t"]
        k = e["kind"]
        if k == "start":
            open_steps[e["step"]] = e["t"]
        elif k == "end":
            t0 = open_steps.pop(e["step"], None)
            if t0 is not None:
                e["dur"] = e["t"] - t0
        elif k == "pause":
            paused = True
        elif k == "resume":
            paused = False
    if last is not None and not paused and open_steps:
        active += time.time() - last
    durs = {}
    for e in events:
        if e["kind"] == "end" and "dur" in e:
            durs[e["step"]] = durs.get(e["step"], 0.0) + e["dur"]
    return active, durs


def hms(s):
    s = int(round(s))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def thumb_size(main):
    """'WxH' of the thumbnails as actually written (PNG IHDR), so a vertical Short is not
    described as 1280x720; falls back to the project orientation when nothing is built yet."""
    for p in sorted((Path(main) / "output").glob("thumbnail-*.png")):
        try:
            head = p.read_bytes()[:24]
            if head[:8] == b"\x89PNG\r\n\x1a\n":
                w, h = struct.unpack(">II", head[16:24])
                return f"{w}x{h}"
        except OSError:
            continue
    try:
        proj = json.loads((project_dir(main) / "project.json").read_text(encoding="utf-8"))
        portrait = int(proj.get("height", 0)) > int(proj.get("width", 0))
    except (OSError, ValueError, TypeError):
        portrait = False
    return "720x1280" if portrait else "1280x720"


def write_info(main, d):
    active, durs = summarise(d)
    lines = [f"Video edit log - {Path(main).name}", f"Updated {datetime.now():%Y-%m-%d %H:%M}", ""]
    lines.append("Timings (waiting for the creator is excluded)")
    lines.append("")
    for k in ORDER:
        if k in durs:
            lines.append(f"  {LABELS[k]:<46s} {hms(durs[k]):>8s}")
    for k in durs:
        if k not in LABELS:
            lines.append(f"  {k:<46s} {hms(durs[k]):>8s}")
    lines += ["", f"  {'Total active time':<46s} {hms(active):>8s}", ""]
    if d["notes"]:
        lines.append("Notes")
        lines.append("")
        for n in d["notes"]:
            lines.append(f"  - {n}")
        lines.append("")
    lines.append("Files")
    lines.append("")
    lines.append(f"  Review project   output/{Path(main).name}_review_v1.fcpxml (macOS) or .xml (Premiere)")
    lines.append("  Final render     output/<final_name> - only after approval")
    lines.append(f"  Thumbnails       output/thumbnail-1..5.png ({thumb_size(main)})")
    lines.append("  Meta             output/meta.txt (5 titles, description, tags)")
    lines.append("  Working files    CLAUDE_VE/ (timeline, graphics, transcripts, builds)")
    lines.append("")
    out = Path(main) / "info.txt"
    out.write_text("\n".join(lines), encoding="utf-8")
    return out, active, durs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("main")
    ap.add_argument("action", choices=["start", "end", "pause", "resume", "note", "write", "status"])
    ap.add_argument("value", nargs="?")
    a = ap.parse_args()
    a.main = video_dir(a.main)
    p, d = load(a.main)
    now = time.time()
    if a.action in ("start", "end"):
        if not a.value:
            ap.error("start/end need a step name")
        d["events"].append({"t": now, "kind": a.action, "step": a.value})
    elif a.action in ("pause", "resume"):
        d["events"].append({"t": now, "kind": a.action})
    elif a.action == "note":
        if not a.value:
            ap.error("note needs text")
        d["notes"].append(a.value)
    save(p, d)
    out, active, durs = write_info(a.main, d)
    if a.action == "status":
        for k, v in durs.items():
            print(f"{k:<16s} {hms(v)}")
        print(f"active {hms(active)}")
    print(out)


if __name__ == "__main__":
    sys.exit(main())
