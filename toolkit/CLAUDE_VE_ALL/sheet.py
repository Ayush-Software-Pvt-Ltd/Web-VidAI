"""Labelled contact sheet of frames from a video at given times.

Usage:
  python sheet.py <video> <out.jpg> --times 1,5.5,9 [--cols 8] [--width 240]
  python sheet.py <video> <out.jpg> --every 6 [--start 0 --end 400]
"""
import argparse
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

from PIL import Image, ImageDraw

from vekit import resources, tools


def grab(video, t, width):
    out = subprocess.run(
        [tools.ffmpeg(), "-v", "error", "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1",
         "-vf", f"scale={width}:-2"] + resources.ffmpeg_thread_args() + ["-f", "image2pipe", "-c:v", "png", "-"],
        capture_output=True, check=True, stdin=subprocess.DEVNULL).stdout
    return Image.open(BytesIO(out)).convert("RGB")


def duration(video):
    return float(subprocess.run(
        [tools.ffprobe(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=True).stdout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--times")
    ap.add_argument("--every", type=float)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float)
    ap.add_argument("--cols", type=int, default=8)
    ap.add_argument("--width", type=int, default=240)
    a = ap.parse_args()
    if a.times:
        times = [float(t) for t in a.times.split(",")]
    else:
        end = a.end if a.end is not None else duration(a.video) - 0.1
        times, t = [], a.start
        while t <= end:
            times.append(round(t, 3))
            t += a.every
    with ThreadPoolExecutor(resources.jobs()) as ex:
        frames = list(ex.map(lambda t: grab(a.video, t, a.width), times))
    w, h = frames[0].size
    rows = (len(frames) + a.cols - 1) // a.cols
    sheet = Image.new("RGB", (a.cols * w, rows * h), "black")
    font = tools.label_font(max(14, w // 12))
    d = ImageDraw.Draw(sheet)
    for i, (t, f) in enumerate(zip(times, frames)):
        x, y = (i % a.cols) * w, (i // a.cols) * h
        sheet.paste(f, (x, y))
        label = f"{t:.1f}"
        d.rectangle([x, y, x + font.getlength(label) + 8, y + font.size + 6], fill="black")
        d.text((x + 4, y + 2), label, font=font, fill="yellow")
    sheet.save(a.out, quality=85)
    print(a.out, sheet.size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
