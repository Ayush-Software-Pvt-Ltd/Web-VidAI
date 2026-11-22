"""YouTube thumbnails from HyperFrames compositions (1280x720 PNG).

Author each thumbnail as an ordinary HyperFrames page at 1920x1080 in
<MAIN>/CLAUDE_VE/thumb_src/<n>/index.html (a `shared` link to the toolkit's shared folder is made for you), then:

  python thumbs.py render <MAIN> [--only 1,3] [--at 1.2]
  python thumbs.py grab <video> <seconds> <out.png> [--width 1920]

`render` snapshots every composition at `--at` seconds (the hold point, after the entrance)
and writes <MAIN>/output/thumbnail-<n>.png at 1280x720.  `grab` pulls a still from the A-roll
or b-roll to use inside a thumbnail (rotation applied, full resolution by default).
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

from vekit import gfx, resources, tools
from vekit.paths import video_dir
from vekit.scratch import scratch_dir



def snapshot(work, at, outdir):
    cmd = tools.hyperframes() + ["snapshot", ".", "--at", str(at), "-o", str(outdir), "--no-end"]
    with resources.gpu_slot():                      # the snapshot renders the page with the GPU
        r = subprocess.run(cmd, cwd=work, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           stdin=subprocess.DEVNULL)
    pngs = sorted(Path(outdir).glob("*.png"))
    if r.returncode != 0 or not pngs:
        raise RuntimeError(f"snapshot failed:\n{r.stdout[-1500:]}\n{r.stderr[-1500:]}")
    return pngs[0]


def render(main, only, at, size):
    main = video_dir(main)
    src = main / "CLAUDE_VE" / "thumb_src"
    outdir = main / "output"
    outdir.mkdir(parents=True, exist_ok=True)
    todo = sorted(p for p in src.iterdir() if p.is_dir() and (p / "index.html").exists()) if src.exists() else []
    if not todo:
        raise SystemExit(f"no thumbnails in {src}/<n>/index.html")
    want = {str(x) for x in only} if only else None
    for p in todo:
        n = p.name
        if want and n not in want:
            continue
        with scratch_dir(f"thumb_{n}_") as tmp:
            work = Path(tmp) / "t"
            shutil.copytree(p, work)
            link = work / "shared"
            if not link.exists():
                gfx.link_shared(link)
            png = snapshot(work, at, Path(tmp) / "shots")
            im = Image.open(png).convert("RGB")
            if im.size != size:
                im = im.resize(size, Image.LANCZOS)
            out = outdir / f"thumbnail-{n}.png"
            im.save(out, "PNG")
            print(out, im.size)


def grab(video, seconds, out, width):
    vf = f"scale={width}:-2:flags=lanczos" if width else "null"
    subprocess.run([tools.ffmpeg(), "-v", "error", "-y", "-ss", f"{seconds:.3f}", "-i", str(video), "-frames:v", "1",
                    "-vf", vf] + resources.ffmpeg_thread_args() + [str(out)], check=True,
                   stdin=subprocess.DEVNULL)
    print(out)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("render"); p.add_argument("main")
    p.add_argument("--only", help="comma separated numbers"); p.add_argument("--at", type=float, default=1.2)
    p.add_argument("--width", type=int, default=1280); p.add_argument("--height", type=int, default=720)
    p = sub.add_parser("grab"); p.add_argument("video"); p.add_argument("seconds", type=float)
    p.add_argument("out"); p.add_argument("--width", type=int, default=0)
    a = ap.parse_args()
    if a.cmd == "render":
        render(a.main, a.only.split(",") if a.only else None, a.at, (a.width, a.height))
    else:
        grab(a.video, a.seconds, a.out, a.width)


if __name__ == "__main__":
    sys.exit(main())
