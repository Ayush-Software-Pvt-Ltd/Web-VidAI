"""`ve.py frames <VIDEO> --project`: still frames of the HyperFrames project the user actually sees.

`ve.py frames` and `ve.py qa` show the toolkit's own ffmpeg composition.  The project that `ve.py hf` writes
is made by a different program (HyperFrames, a browser), so a graphic can look right in the first and wrong in
the second (text over the host because the page has no background, a b-roll that does not play).  This module
snapshots the written project with the pinned HyperFrames CLI (`hyperframes snapshot`) and checks the pictures.

  ve.py frames <VIDEO> --project [--times t1,t2,...] [--every S] [--res 720|1080]

Output, in <VIDEO>/CLAUDE_VE/frames_project/ (earlier files of this command are replaced):
  NN_<seconds>s_<clip id>.jpg   one frame (short side --res, never enlarged)
  sheet_K.jpg                   contact sheets of up to 20 frames, labelled with the time and the clip

Which times: --times gives exact seconds on the edited timeline; --every S gives the middle of every S-second span;
both together are added up.  With neither, one frame inside every graphic, overlay, keyword hit and b-roll clip
(two in a clip of 5 seconds or more) and four host frames where no other clip plays, at most 40 (MAX_FRAMES).

One line per frame, then one `WARN` line per problem found by numbers on small copies of the pictures:
  - a full-screen graphic or b-roll frame whose picture is mostly the A-roll host frame of the same time
    (the clip is not covering the host, MATCH_WARN of the pixels agree with it),
  - a black frame (no clip on screen, or a graphic that did not draw),
  - a frame identical to the previous full-screen frame of another clip (the clip did not change anything).
"""
import json
import os
import re
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path

from . import resources, tools
from .scratch import scratch_dir

MAX_FRAMES = 40                     # default plan and --every; explicit --times may be up to HARD_MAX
HARD_MAX = 80
SHEET_FRAMES = 20
HOST_FRAMES = 4
LONG_CLIP = 5.0                     # seconds from which a graphic or b-roll gets two frames
THUMB_W = 96                        # width of the small copies the checks compare
TOLERANCE = 28                      # largest per-channel difference (of 255) of two pixels that "agree"
MATCH_WARN = 0.6                    # share of agreeing pixels from which a frame "looks like the host"
IDENTICAL_DIFF = 0.004              # mean difference (0 to 1) below which two frames are "identical"
BLACK_LUMA = 6.0                    # mean and spread of the luma (of 255) of a black frame
FULL_SCREEN = ("graphic", "broll")
PICTURE_KINDS = ("graphic", "overlay", "hit", "broll")
FOLDER = "frames_project"


class FramesError(Exception):
    """A problem for one line of output."""


# ------------------------------------------------------------------------------------ the project

def project_folder(vdir):
    """<video>/output/<video folder name>.hf (as hfproject.export writes it)."""
    return Path(vdir) / "output" / f"{Path(vdir).name}.hf"


def _seconds(text, default=0.0):
    try:
        return float(Fraction(str(text)))
    except (ValueError, ZeroDivisionError):
        return default


def read_clips(index_html):
    """(root attributes, clips) of an index.html: every clip is a dict with id, kind, track, start, dur, label,
    src, media_start, rate and style (seconds as floats)."""
    from .hfproject import _Index
    parser = _Index()
    parser.feed(index_html)
    root = parser.root or {}
    clips = []
    for tag, a in parser.clips:
        kind = a.get("data-vidai-kind") or ("aroll" if tag == "video" and a.get("data-track-index") == "0" else "")
        if not kind or "data-start" not in a:
            continue
        clips.append({"id": a.get("id") or kind, "kind": kind, "track": int(_seconds(a.get("data-track-index"))),
                      "start": _seconds(a.get("data-start")), "dur": _seconds(a.get("data-duration")),
                      "label": a.get("data-vidai-label") or "", "src": a.get("src") or "",
                      "media_start": _seconds(a.get("data-media-start")),
                      "rate": _seconds(a.get("data-playback-rate"), 1.0) or 1.0, "style": a.get("style") or ""})
    return root, clips


def clip_at(clips, t, kinds=None):
    """The clip on the highest track that is on screen at `t` (kinds: only these), or None."""
    best = None
    for c in clips:
        if kinds is not None and c["kind"] not in kinds:
            continue
        if c["kind"] in ("sfx", "music") or not c["start"] <= t < c["start"] + c["dur"]:
            continue
        if best is None or c["track"] > best["track"]:
            best = c
    return best


# ------------------------------------------------------------------------------------ the times

def parse_times(values):
    """['1,2.5', '4'] -> [1.0, 2.5, 4.0]; raises FramesError for something that is not a non-negative number."""
    out = []
    for v in values or []:
        for part in re.split(r"[,\s]+", str(v).strip()):
            if not part:
                continue
            try:
                t = float(part)
            except ValueError:
                raise FramesError(f"--times wants seconds like 1.5,4,9.25, not '{part}'.")
            if not t >= 0 or t != t or t == float("inf"):
                raise FramesError(f"--times wants seconds of at least 0, not '{part}'.")
            out.append(t)
    return out


def default_times(clips, total, cap=MAX_FRAMES):
    """The default plan: [(time, why)] sorted by time, at most `cap`.  Full-screen clips come first, then
    overlays and hits, then the second frames of long clips, then host frames."""
    picture = sorted((c for c in clips if c["kind"] in PICTURE_KINDS and c["dur"] > 0), key=lambda c: c["start"])
    tiers = [[], [], [], []]

    def inside(c, f):
        """A time at fraction `f` of the clip, moved (to 0.5, 0.35, 0.65, 0.2, 0.8) to where it is the clip on top."""
        for g in (f, 0.5, 0.35, 0.65, 0.2, 0.8):
            t = c["start"] + c["dur"] * g
            if clip_at(clips, t, PICTURE_KINDS + ("fade",)) is c:
                return t
        return c["start"] + c["dur"] * f

    for c in picture:
        full = c["kind"] in FULL_SCREEN
        if c["dur"] >= LONG_CLIP and full:
            tiers[0].append(inside(c, 0.3))
            tiers[2].append(inside(c, 0.7))
        else:
            tiers[0 if full else 1].append(inside(c, 0.5))
    covered = [(c["start"], c["start"] + c["dur"]) for c in clips if c["kind"] not in ("aroll", "sfx", "music")]
    free = [k / 10 for k in range(int(total * 10)) if k / 10 >= 0.05 and not any(s <= k / 10 < e for s, e in covered)]
    picks = []
    for f in (0.1, 0.35, 0.6, 0.85)[:HOST_FRAMES]:
        if free:
            near = min(free, key=lambda x: abs(x - f * total))
            if near not in picks:
                picks.append(near)
    tiers[3] = picks
    chosen = [t for tier in tiers for t in tier][:cap]
    return sorted(set(round(t, 3) for t in chosen)), len([t for tier in tiers for t in tier])


def every_times(total, step):
    if not step or step <= 0:
        raise FramesError("--every wants a number of seconds above 0.")
    out, k = [], 0
    while (k + 0.5) * step < total:
        out.append(round((k + 0.5) * step, 3))
        k += 1
    return out


# ------------------------------------------------------------------------------------ the pictures

def thumb(im, w=THUMB_W, h=None):
    """A small RGB copy: (width, height, bytes)."""
    from PIL import Image
    h = h or max(2, round(w * im.height / im.width))
    small = im.convert("RGB").resize((w, h), Image.BOX)
    return (w, h, small.tobytes())


def match_fraction(a, b):
    """Share of pixels (0 to 1) whose channels all differ by at most TOLERANCE."""
    (w, h, pa), (_, _, pb) = a, b
    n = w * h
    hit = 0
    for i in range(n):
        j = i * 3
        if abs(pa[j] - pb[j]) <= TOLERANCE and abs(pa[j + 1] - pb[j + 1]) <= TOLERANCE \
                and abs(pa[j + 2] - pb[j + 2]) <= TOLERANCE:
            hit += 1
    return hit / n if n else 0.0


def mean_diff(a, b):
    """Mean absolute difference per channel, 0 to 1."""
    pa, pb = a[2], b[2]
    return sum(abs(x - y) for x, y in zip(pa, pb)) / max(1, len(pa)) / 255


def is_black(a):
    """True when the mean luma and its spread are both within BLACK_LUMA."""
    p = a[2]
    luma = [(299 * p[i] + 587 * p[i + 1] + 114 * p[i + 2]) / 1000 for i in range(0, len(p), 3)]
    if not luma:
        return False
    mean = sum(luma) / len(luma)
    spread = (sum((x - mean) ** 2 for x in luma) / len(luma)) ** 0.5
    return mean <= BLACK_LUMA and spread <= BLACK_LUMA


def _transform(style):
    """(scale, translate x px, translate y px) of a clip's static style (the punch-in)."""
    scale, tx, ty = 1.0, 0.0, 0.0
    m = re.search(r"scale\(\s*([-\d.]+)", style)
    if m:
        scale = float(m.group(1)) or 1.0
    m = re.search(r"translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px", style)
    if m:
        tx, ty = float(m.group(1)), float(m.group(2))
    return scale, tx, ty


def host_thumb(project, clip, t, size, project_w):
    """A small copy of the A-roll source frame that plays at `t` under `clip`, placed as the project places it
    (covering the frame, with the punch-in), or None when ffmpeg cannot read it."""
    from PIL import Image
    w, h = size
    src = Path(project).joinpath(*[p for p in clip["src"].split("/") if p])
    at = max(0.0, clip["media_start"] + (t - clip["start"]) * clip["rate"])
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"
    try:
        r = subprocess.run([tools.ffmpeg(), "-v", "error", "-ss", f"{at:.3f}", "-i", str(src), "-frames:v", "1",
                            "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                           capture_output=True, stdin=subprocess.DEVNULL, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0 or len(r.stdout) != w * h * 3:
        return None
    im = Image.frombytes("RGB", (w, h), r.stdout)
    k, tx, ty = _transform(clip["style"])
    if k != 1.0 or tx or ty:
        f = w / float(project_w or w)
        cx, cy = w / 2, h / 2
        a, c = 1 / k, cx - (cx + tx * f) / k
        e = cy - (cy + ty * f) / k
        im = im.transform((w, h), Image.AFFINE, (a, 0, c, 0, a, e), Image.BILINEAR)
    return (w, h, im.tobytes())


# ------------------------------------------------------------------------------------ HyperFrames

def snapshot(project, times, out_dir, timeout):
    """Run `hyperframes snapshot` once for all `times` and return the PNG paths in the order of `times`."""
    cmd = tools.hyperframes() + ["snapshot", str(project), "--at", ",".join(f"{t:g}" for t in times),
                                 "--no-end", "-o", str(out_dir)]
    try:
        with resources.gpu_slot():                      # the browser captures with the GPU
            r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                               stdin=subprocess.DEVNULL, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        raise FramesError(f"HyperFrames is not available ({type(e).__name__}: {str(e)[:120]}); "
                          "install the toolkit's packages or set VE_HYPERFRAMES.")
    pngs = {}
    for p in Path(out_dir).glob("frame-*.png"):
        m = re.match(r"frame-(\d+)-", p.name)
        if m:
            pngs[int(m.group(1))] = p
    if r.returncode != 0 or len(pngs) != len(times):
        lines = [x.strip() for x in (r.stderr + "\n" + r.stdout).splitlines() if x.strip()]
        bad = [x for x in lines if re.search(r"error|cannot|not found|failed|unable", x, re.I)]
        why = (bad or lines or [f"exit code {r.returncode}"])[0 if bad else -1][:200]
        raise FramesError(f"HyperFrames could not snapshot the project ({len(pngs)} of {len(times)} frames): {why}")
    return [pngs[i] for i in range(len(times))]


# ------------------------------------------------------------------------------------ the checks

def check_frames(frames):
    """WARN texts for `frames`, a list of dicts with t, clip (the clip on top or None), thumb and host (the
    thumb of the A-roll host at that time, or None)."""
    warns, previous = [], None
    for f in frames:
        c, label = f["clip"], f["name"]
        kind = c["kind"] if c else "aroll"
        if kind != "fade" and is_black(f["thumb"]):
            warns.append(f"WARN t={f['t']:.2f}s {label}: black frame; nothing is drawn here.")
        if kind in FULL_SCREEN and f.get("host") is not None:
            m = match_fraction(f["thumb"], f["host"])
            if m >= MATCH_WARN:
                warns.append(f"WARN t={f['t']:.2f}s {label}: {round(m * 100)}% of this full-screen {kind} frame is the "
                             "A-roll host frame of the same time; the clip does not cover the host "
                             "(missing background, or the media does not play).")
        if kind in FULL_SCREEN:
            if previous is not None and previous["clip"]["id"] != c["id"] and not is_black(f["thumb"]) \
                    and mean_diff(f["thumb"], previous["thumb"]) <= IDENTICAL_DIFF:
                warns.append(f"WARN t={f['t']:.2f}s {label}: identical to the previous full-screen frame "
                             f"({previous['name']} at {previous['t']:.2f}s); these clips should differ.")
            previous = f
    return warns


# ------------------------------------------------------------------------------------ the command

def name_of(c):
    return f"{c['id']} {c['kind']}" + (f' "{c["label"]}"' if c["label"] else "") if c else "host"


def _clear(folder):
    for p in Path(folder).glob("*.jpg"):
        if re.match(r"(\d\d_.*|sheet_\d+)\.jpg$", p.name):
            p.unlink()


def run(a, say=print):
    """The `frames --project` command (ve.py cmd_frames).  Returns the exit code; one `ERROR ...` line on stderr
    when it fails."""
    import sys
    from PIL import Image
    from .paths import project_dir, video_dir
    from .qa import tile
    try:
        res = resources.check_resolution(a.res)
        vdir = video_dir(a.main)
        project = project_folder(vdir)
        index = project / "index.html"
        if not index.is_file():
            raise FramesError(f"there is no project at {project}; run `ve.py hf <video folder>` first.")
        root, clips = read_clips(index.read_text(encoding="utf-8"))
        total = _seconds(root.get("data-duration"))
        if total <= 0:
            raise FramesError(f"the project {project} has no duration.")
        picked = parse_times(getattr(a, "times", None))
        every = getattr(a, "every", None)
        wanted, notes, available = [], [], 0
        if every is not None:
            wanted += every_times(total, every)
        wanted += picked
        if not wanted:
            wanted, available = default_times(clips, total)
            if available > len(wanted):
                notes.append(f"NOTE the plan has {available} frames; {len(wanted)} are shown (the full-screen clips "
                             "first). Use --times for others.")
        last = total - 0.02
        times = []
        for t in wanted:
            if t > last:
                notes.append(f"NOTE time {t:g}s is after the end of the edit ({total:.2f}s); using {last:.2f}s.")
                t = last
            if round(t, 3) not in times:
                times.append(round(t, 3))
        times.sort()
        limit = HARD_MAX if picked else MAX_FRAMES
        if len(times) > limit:
            notes.append(f"NOTE {len(times)} frames were asked for; the first {limit} are shown.")
            times = times[:limit]
        if not times:
            raise FramesError("there is nothing to show; pass --times or --every.")
        stamp = vdir / "CLAUDE_VE" / "build" / "timeline.json"
        if stamp.is_file() and stamp.stat().st_mtime > index.stat().st_mtime + 1:
            notes.append("WARN the project is older than build/timeline.json; run `ve.py hf <video folder>` "
                         "to see the latest edit.")
        out = project_dir(vdir) / FOLDER
        out.mkdir(parents=True, exist_ok=True)
        _clear(out)
        with scratch_dir("ve_snap_") as tmp:
            pngs = snapshot(project, times, tmp, timeout=min(1200, 120 + 12 * len(times)))
            frames = []
            for i, (t, png) in enumerate(zip(times, pngs)):
                c = clip_at(clips, t, PICTURE_KINDS + ("fade",))
                with Image.open(png) as im:
                    im.load()
                    im = im.convert("RGB")
                small = thumb(im)
                scale = min(1.0, res / min(im.size))
                shown = im if scale >= 1 else im.resize((max(2, round(im.width * scale)), max(2, round(im.height * scale))),
                                                        Image.LANCZOS)
                path = out / f"{i:02d}_{t:07.2f}s_{c['id'] if c else 'host'}.jpg"
                shown.save(path, quality=88)
                host = None
                if c and c["kind"] in FULL_SCREEN:
                    base = clip_at(clips, t, ("aroll",))
                    if base and base["src"]:
                        host = host_thumb(project, base, t, small[:2], _seconds(root.get("data-width")))
                frames.append({"t": t, "clip": c, "name": f"{c['id']} ({c['kind']})" if c else "host",
                               "thumb": small, "host": host, "path": path, "label": name_of(c)})
        sheets = []
        portrait = (small[1] > small[0]) if frames else False
        for k in range(0, len(frames), SHEET_FRAMES):
            sheet = out / f"sheet_{k // SHEET_FRAMES + 1}.jpg"
            tile([(f["path"], f"{f['t']:.1f}s {f['clip']['id'] if f['clip'] else 'host'}")
                  for f in frames[k:k + SHEET_FRAMES]], sheet, cols=5 if portrait else 4, width=200 if portrait else 320)
            sheets.append(sheet)
    except FramesError as e:
        print(f"ERROR frames --project: {e}", file=sys.stderr)
        return 1
    for f in frames:
        say(f"t={f['t']:.2f}s  {f['label']}  -> {f['path']}")
    warns = check_frames(frames)
    for line in notes + warns:
        say(line)
    for s in sheets:
        say(f"sheet: {s}")
    say(f"{len(frames)} frames of {project.name} at {res}p, {len([w for w in warns if w.startswith('WARN')])} warnings")
    return 0
