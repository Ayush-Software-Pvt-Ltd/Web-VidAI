"""The edit as a HyperFrames project: `ve.py hf <video folder>` -> <video>/output/<name>.hf/ (SPEC section 10).

How every element of the timeline (build/timeline.json) is written:

  A-roll       <video> on track 0 playing the original file (assets/media/<name>, a link), cut with
               data-media-start and data-duration.  The punch-in (clip scale and position) is a static
               CSS transform in the clip's style attribute; a sideways file (project "aroll_rotate") is a
               turned, resized box.  The sound stays on the video (data-has-audio, data-volume = the clip's
               dB gain), so it follows the picture when a person trims, moves, splits or deletes A-roll clips.
               The fades are clip-edge fades, data-fade-in and data-fade-out in seconds (linear, multiplied
               on data-volume): the end of the edit and an 8 ms de-click at every cut that does not continue
               the same source (fade_plan; the server writes them again by the same rule, lanes.js, after
               every hand edit, so none is left behind by an edit that made it obsolete).
  B-roll       <video muted> on track 1 playing the original file (not the conformed copy) with the crop and
               turn of the conformed copy as static style.  Footage that the mezzanine slowed to play every
               frame once (30 fps in a 23.976 edit) keeps that as data-playback-rate.  A synced b-roll (a
               second angle that follows the A-roll's cuts) is one clip per kept piece.  With push, pull or
               drift motion the clip is a motion graphic host (data-vidai-kind="broll") whose sub-composition
               holds the same video inside a box that a GSAP tween zooms or slides: the only place where
               HyperFrames can animate.  The movement is one JSON attribute of the box (data-vidai-motion) that
               the file's script reads, and the video's data-media-start and data-duration are plain
               attributes, so the server can trim, move and split such a clip like a plain B-roll
               (editMotion.js; broll_composition below writes the same shape).
               A synced b-roll with a composed layout (a box, rounded corners, "bg", "pip"; broll.py) is one host
               per kept piece too, since the layers (background picture, screen in its box, the host in a circle)
               need more z-levels than track 1 has: its file holds the picture, the screen video, and the host as a
               second muted video of the A-roll file in a round box (layout_composition); the A-roll on track 0
               keeps the sound.
  graphic      compositions/<id>.html made from the template (or the video's gfx_src folder), variables
               filled in; the host is on track 1 (full screen), 2 (overlay), 3 (keyword hit), 4 (end fade).
  sfx / music  <audio> on tracks 10 and up (a new track where two overlap), data-volume from the dB value;
               the sound file is copied to assets/sfx/.

Not represented (the exporter says so on screen and the README lists it): a graphic resumed in the middle
(`G:name@seconds`) and the final -14 LUFS levelling and limiter of the old mix (the server levels the sound after rendering).
"""
import html
import json
import math
import os
import posixpath
import re
import shutil
import subprocess
from datetime import datetime, timezone
from fractions import Fraction
from html.parser import HTMLParser
from pathlib import Path

from . import tools
from .broll import DRIFT_ZOOM, PUSH
from .gfx import link_media
from .model import Timeline
from .paths import KIT, SHARED, TEMPLATES, project_dir, video_dir

KINDS = ("aroll", "broll", "graphic", "overlay", "hit", "fade", "sfx", "music")
TRACK = {"aroll": 0, "broll": 1, "graphic": 1, "overlay": 2, "hit": 3, "fade": 4}
FIRST_SOUND_TRACK = 10
ROOT_SCRIPT = (Path(__file__).with_name("hf_root_script.js")).read_text(encoding="utf-8").strip()
GSAP = "shared/js/gsap.min.js"
SKIP_NAMES = {".DS_Store", "Thumbs.db", ".hyperframes", "renders", "node_modules", "shared", "graphic.json"}
DECIMALS = 9
DECLICK = "0.008"                            # seconds of the fade at a cut in the sound (the text a file holds)
INNER_EXTRA = 600                            # seconds a B-roll's inner video may last beyond its host


class ExportError(Exception):
    """A problem described in plain sentences."""


def graphic_record(src_dir):
    """{"template", "variables"} from the graphic.json that `ve.py graphic` wrote beside a graphic's index.html,
    or None (a hand-written graphic folder, or a file that is not readable or not of that shape)."""
    try:
        rec = json.loads((Path(src_dir) / "graphic.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(rec, dict) or not isinstance(rec.get("template"), str) or not rec["template"]:
        return None
    variables = rec.get("variables")
    return {"template": rec["template"], "variables": dict(variables) if isinstance(variables, dict) else {}}


# ------------------------------------------------------------------------------ small helpers

def num(x):
    """A number for an attribute or a style: at most 9 decimals, no trailing zeros."""
    scaled = round(Fraction(x) * 10 ** DECIMALS)
    whole, part = divmod(abs(scaled), 10 ** DECIMALS)
    text = str(whole) + ("." + str(part).zfill(DECIMALS).rstrip("0") if part else "")
    return "-" + text if scaled < 0 else text


def seconds(frames, fps):
    return num(Fraction(frames) / fps)


def write_text(path, text, encoding="utf-8"):
    """UTF-8 with plain line ends on every system (Path.write_text has no newline argument before Python 3.10)."""
    with open(path, "w", encoding=encoding, newline="\n") as f:
        f.write(text)


def attr(value):
    return html.escape(str(value), quote=True)


def px(v):
    return num(Fraction(round(v, 2)).limit_denominator(100)) + "px"


def fps_text(fps):
    return str(Fraction(fps))


def link_name(name, taken):
    """A file name for a link in assets/media: letters, digits, marks and . _ - ( ) only, unique."""
    out = "".join(c if (c.isalnum() or c in "._-()") else "_" for c in name).strip("._") or "media"
    stem, dot, ext = out.rpartition(".")
    if not dot:
        stem, ext = out, ""
    n, cand = 1, out
    while cand.lower() in taken:
        n += 1
        cand = f"{stem}-{n}" + (f".{ext}" if ext else "")
    return cand


def probe(path):
    """Length and shape of a media file, measured with ffprobe."""
    r = subprocess.run([tools.ffprobe(), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise ExportError(f"The file {path} cannot be read with ffprobe: {r.stderr.strip()[-200:]}")
    d = json.loads(r.stdout)
    v = next((s for s in d["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in d["streams"] if s["codec_type"] == "audio"), None)
    dur = Fraction(str(d["format"].get("duration") or (v or a or {}).get("duration") or "0"))
    if not v:
        return {"dur": dur, "fps": None, "frames": 0, "w": 0, "h": 0, "audio": a is not None}
    fps = Fraction(v.get("r_frame_rate") or "30")
    frames = int(v.get("nb_frames") or 0) or int(dur * fps + Fraction(1, 2))
    rot = 0
    for sd in v.get("side_data_list", []):
        if "rotation" in sd:
            rot = int(sd["rotation"])
    rot = int(v.get("tags", {}).get("rotate", rot) or 0)
    w, h = int(v["width"]), int(v["height"])
    if abs(rot) % 180 == 90:
        w, h = h, w
    return {"dur": dur, "fps": fps, "frames": frames, "w": w, "h": h, "audio": a is not None}


# ------------------------------------------------------------------------------ the model

class Source:
    """A media file the project plays."""

    def __init__(self, name, path, original, info, fps):
        self.name, self.path, self.original, self.info = name, path, original, info
        self.fps = info["fps"] or fps
        self.frames = info["frames"] if info["fps"] else int(info["dur"] * fps + Fraction(1, 1000))

    def length(self):
        return Fraction(self.frames) / self.fps


class Item:
    """One clip of index.html."""

    def __init__(self, kind, start, dur, label, **kw):
        self.kind, self.start, self.dur, self.label = kind, start, dur, label
        self.track = TRACK.get(kind, FIRST_SOUND_TRACK)
        self.id = ""
        self.src = kw.get("src")
        self.media_start = kw.get("media_start", Fraction(0))
        self.rate = kw.get("rate", Fraction(1))
        self.style = kw.get("style", "")
        self.volume = kw.get("volume")
        self.muted = kw.get("muted", False)
        self.fade_in = self.fade_out = None                # seconds as text, set by plan_fades()
        self.graphic = kw.get("graphic")
        self.uses = kw.get("uses")                       # the media file a B-roll host plays (for edit.json)
        self.also = kw.get("also", ())                   # more files of a layout host (the host's A-roll)
        self.host_values = None

    @property
    def end(self):
        return self.start + self.dur


# ------------------------------------------------------------------------------ geometry (static CSS)

def place(W, H, sw, sh, vis, crop=None, rot=0, radius=0.0, scale=1.0, pos=(0.0, 0.0)):
    """The CSS (without z-index) that shows a picture of sw x sh (clockwise-turned by `rot`) so that
    the `crop` window (fractions of the turned picture) fills the frame rectangle `vis` = (x, y, w, h),
    then applies the Final Cut transform: scale about the frame centre, `pos` in percent of the frame
    height (+y up).  An empty string means the clip's default style (the whole frame) is right."""
    vx, vy, vw, vh = vis
    x0, y0, x1, y1 = crop or (0.0, 0.0, 1.0, 1.0)
    pw, ph = (sh, sw) if rot in (90, 270) else (sw, sh)
    k = max(vw / ((x1 - x0) * pw), vh / ((y1 - y0) * ph))
    ww, wh = (x1 - x0) * pw * k, (y1 - y0) * ph * k
    wx, wy = vx + (vw - ww) / 2, vy + (vh - wh) / 2                  # the window on the frame
    cx, cy = wx - x0 * pw * k + pw * k / 2, wy - y0 * ph * k + ph * k / 2   # centre of the turned picture
    ew, eh = sw * k, sh * k                                           # the element's own box
    left, top = cx - ew / 2, cy - eh / 2
    plain = not crop and not radius and not rot and tuple(vis) == (0, 0, W, H)
    css = []
    if not plain:
        css.append(f"inset:auto;left:{px(left)};top:{px(top)};width:{px(ew)};height:{px(eh)};object-fit:fill")
    if crop or radius:
        t, r, b, l = {0: (y0 * eh, (1 - x1) * ew, (1 - y1) * eh, x0 * ew),
                      90: ((1 - x1) * eh, (1 - y1) * ew, x0 * eh, y0 * ew),
                      180: ((1 - y1) * eh, x0 * ew, y0 * eh, (1 - x1) * ew),
                      270: (x0 * eh, y0 * ew, (1 - x1) * eh, (1 - y1) * ew)}[rot]
        css.append(f"clip-path:inset({px(t)} {px(r)} {px(b)} {px(l)}" + (f" round {px(radius)}" if radius else "") + ")")
    ox, oy = W / 2 - left, H / 2 - top                                # the frame centre in the element
    parts = []
    if pos[0] or pos[1]:
        parts.append(f"translate({px(pos[0] * H / 100.0)},{px(-pos[1] * H / 100.0)})")
    if scale != 1.0:
        parts.append(f"scale({num(round(scale, 5))})")
    if rot:
        dx, dy = ew / 2 - ox, eh / 2 - oy
        parts.append(f"translate({px(dx)},{px(dy)}) rotate({rot}deg) translate({px(-dx)},{px(-dy)})")
    if parts:
        css.append("transform:" + " ".join(parts))
        if not plain:
            css.append(f"transform-origin:{px(ox)} {px(oy)}")
    return ";".join(css)


# ------------------------------------------------------------------------------ the export

# ------------------------------------------------------------------------------ the fades in the sound

def fade_plan(clips, fps, end_frames):
    """Where the A-roll's sound fades (the one rule; server/src/timeline/lanes.js is the same rule and
    server/test/support/fixtures/fade-rule.json is run by both).

    `clips` is the A-roll in playing order, each (src, media_start in project frames, rate, dur in frames,
    sound).  Returns one (fade_in, fade_out) per clip, in seconds as text (None for none).

    A cut between two different sources gets an 8 ms fade out and an 8 ms fade in (a de-click); a cut that
    continues the same source (same file and speed, the second starts where the first stops) gets nothing.
    The first clip fades in over 8 ms.  The last clip's tail is the end fade, `end_frames` long (the length of
    the end fade picture) and at most the clip's own length, else the 8 ms de-click.  A clip shorter than four
    de-clicks, and a clip with no sound, has no fades and continues nothing."""
    tolerance = Fraction(1, 100)

    def continues(a, b):
        return (a[4] and b[4] and a[0] is not None and a[0] == b[0] and a[2] == b[2]
                and abs(a[1] + a[3] * a[2] - b[1]) <= tolerance)

    out = []
    for i, c in enumerate(clips):
        src, media_start, rate, dur, sound = c
        if not sound or Fraction(dur) / fps < 4 * Fraction(DECLICK):
            out.append((None, None))
            continue
        fade_in = None if i and continues(clips[i - 1], c) else DECLICK
        if i + 1 == len(clips):
            fade_out = seconds(min(end_frames, dur), fps) if end_frames > 0 else DECLICK
        else:
            fade_out = None if continues(c, clips[i + 1]) else DECLICK
        out.append((fade_in, fade_out))
    return out


class Exporter:
    def __init__(self, main, tl=None, log=print):
        self.vdir = video_dir(main)
        self.pdir = project_dir(self.vdir)
        self.log = log
        self.warnings = []
        self.tl = tl or Timeline.load(self.pdir / "build" / "timeline.json", base=self.vdir)
        if self.tl.base is None:
            self.tl.base = self.vdir
        self.tl.layout()
        self.project = self._json(self.pdir / "project.json", {})
        self.hits = self._json(self.pdir / "hits.json", {})
        self.fps = self.tl.rate.fps
        self.W, self.H = (1920, 1080) if self.tl.width >= self.tl.height else (1080, 1920)
        self.sources, self.names, self.items = {}, set(), []
        self.sound_files = {}
        self.layout_files = {}                               # assets/layout/<name> -> the picture it shows
        self.graphics = []
        self.total = 0

    @staticmethod
    def _json(path, default):
        p = Path(path)
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default

    def warn(self, text):
        self.warnings.append(text)
        self.log("WARN " + text)

    def source(self, original, folder="media"):
        key = str(original)
        if key not in self.sources:
            original = Path(original)
            if not original.exists():
                raise ExportError(f"The media file {original} is not there, so the project cannot play it.")
            name = link_name(original.name, self.names)
            self.names.add(name.lower())
            self.sources[key] = Source(name, f"assets/{folder}/{name}", str(original.resolve()), probe(original), self.fps)
        return self.sources[key]

    # -- timeline -> items
    def build_items(self):
        tl, fps = self.tl, self.fps
        for k, c in enumerate(tl.spine):
            if not c.asset:
                raise ExportError(f"The A-roll has a gap at {float(Fraction(c.rec) / fps):.2f} seconds, "
                                  "and the A-roll track may have none.")
            a = tl.assets[c.asset]
            src = self.source(tl.path(a["file"]))
            style = place(self.W, self.H, src.info["w"], src.info["h"], (0, 0, self.W, self.H),
                          rot=int(a.get("rotate", 0)), scale=c.scale, pos=tuple(c.pos))
            self.items.append(Item("aroll", c.rec, c.dur, c.name or "A-roll", src=src, media_start=Fraction(c.src) / fps,
                                   style=style, muted=not src.info["audio"], volume=self._gain(c)))
        for c in sorted(tl.connected, key=lambda c: (c.rec, c.lane, c.asset)):
            a = tl.assets[c.asset]
            kind = a["kind"]
            if kind == "broll":
                self._broll(c, a)
            elif kind == "gfx":
                self._graphic(c, a)
            elif kind in ("sfx", "music"):
                self._sound(c, a, kind)
            else:
                self.warn(f"The clip {c.name or c.asset} is of the kind {kind}, which a project cannot hold; it is left out.")

    @staticmethod
    def _gain(c):
        return round(10 ** (c.volume_db / 20), 4) if c.volume_db else None

    def _broll(self, c, a):
        fps, W, H = self.fps, self.W, self.H
        src = self.source(self.tl.path(a["src_file"]))
        label = c.name or a.get("name") or "B-roll"
        motion = a.get("motion", "none")
        sw, sh = src.info["w"], src.info["h"]
        if "ranges" in a:                                     # a synced b-roll: one clip per kept piece
            lay = a.get("layout") or {}
            crop = tuple(lay["crop"]) if lay.get("crop") else None
            x0, y0, x1, y1 = crop or (0, 0, 1, 1)
            if lay.get("box"):
                bx, by, bw, bh = lay["box"]
                cw, ch = sw * (x1 - x0), sh * (y1 - y0)
                k = min(bw * W / cw, bh * H / ch)
                ow, oh = cw * k, ch * k
                vis = (bx * W + (bw * W - ow) / 2, by * H + (bh * H - oh) / 2, ow, oh)
            else:
                vis = (0, 0, W, H)
            if lay.get("bg") or lay.get("pip") or lay.get("box") or lay.get("radius"):
                self._layout_broll(c, a, src, label, lay, vis, crop)
                return
            style = place(W, H, sw, sh, vis, crop=crop, radius=lay.get("radius", 0) * H,
                          scale=c.scale, pos=tuple(c.pos))
            rec, on = c.rec, c.src
            for t, n in a["ranges"]:
                mstart = Fraction(t).limit_denominator(10000)
                if motion != "none":
                    self.items.append(Item("broll", rec, n, label, uses=src,
                                           graphic={"broll": self._broll_host(src, mstart, Fraction(1), style, a, on, on + n)}))
                else:
                    self.items.append(Item("broll", rec, n, label, src=src, media_start=mstart, style=style, muted=True))
                rec += n
                on += n
            return
        realtime = bool(a.get("realtime"))
        sfps = fps if realtime else Fraction(a["src_fps"])
        rate = Fraction(1) if realtime else fps / sfps          # every source frame once at the edit's rate
        media_start = Fraction(a["src_start"] + c.src) / sfps
        style = place(W, H, sw, sh, (0, 0, W, H), crop=tuple(a["crop"]) if a.get("crop") else None,
                      rot=int(a.get("rotate", 0)), scale=c.scale, pos=tuple(c.pos))
        dur = c.dur
        left = src.length() - media_start
        if Fraction(dur) / fps * rate > left + Fraction(1, 100) / fps:
            dur = max(1, int(left / rate * fps))
            self.warn(f"B-roll {label} runs past the end of its file; it is shortened to {dur} frames.")
        if motion != "none":
            self.items.append(Item("broll", c.rec, dur, label, uses=src,
                                   graphic={"broll": self._broll_host(src, media_start, rate, style, a, c.src, c.src + dur)}))
        else:
            self.items.append(Item("broll", c.rec, dur, label, src=src, media_start=media_start, rate=rate, style=style,
                                   muted=True))

    def _layout_picture(self, rel_path, what, label):
        """The project path of a picture of a layout (the background): linked into assets/layout/."""
        path = Path(self.tl.path(rel_path))
        if not path.exists():
            raise ExportError(f"B-roll {label}: the {what} {path} is not there, so the project cannot show it.")
        for dest, original in self.layout_files.items():
            if original == path:
                return dest
        taken = {Path(d).name.lower() for d in self.layout_files}
        dest = f"assets/layout/{link_name(path.name, taken)}"
        self.layout_files[dest] = path
        return dest

    def _layout_broll(self, c, a, src, label, lay, vis, crop):
        """A synced b-roll whose layout is composed (a box, rounded corners, a background picture, the host in a
        circle): the toolkit's own build lays it out on a background, so the project does the same.
        The pieces cannot be separate clips: track 1 holds one clip at a time and a clip's z-index is its track,
        so a background, the screen and the host's circle (three layers above the A-roll) have no tracks to sit on.
        Each kept piece is therefore one host of kind broll (track 1, like a B-roll with motion) whose
        compositions/<id>.html holds the layers: the background picture, the screen recording in its box (crop and
        rounded corners as clip-path) and the host as a second video of the A-roll file, muted (the A-roll clip
        on track 0 keeps the sound), in a round box.  The pieces follow the A-roll's cuts like plain pieces."""
        fps, W, H = self.fps, self.W, self.H
        sw, sh = src.info["w"], src.info["h"]
        pip = lay.get("pip")
        host_src = None
        if pip:
            host_src = self.source(self.tl.path(pip["file"]))
            hw, hh = host_src.info["w"], host_src.info["h"]
            bx, by, bw, bh = pip["box"]
            d = min(bw * W, bh * H)
            hx0, hy0, hx1, hy1 = pip.get("crop") or (0, 0, 1, 1)
            ew, eh = d / (hx1 - hx0), d / (hy1 - hy0)           # the crop window is stretched to the circle
            circle = {"x": bx * W + (bw * W - d) / 2, "y": by * H + (bh * H - d) / 2, "d": d,
                      "style": "inset:auto;left:%s;top:%s;width:%s;height:%s;object-fit:fill" % (
                          px(-hx0 * ew), px(-hy0 * eh), px(ew), px(eh))}
        bg = self._layout_picture(lay["bg"], "background picture", label) if lay.get("bg") else None
        style = place(W, H, sw, sh, vis, crop=crop, radius=lay.get("radius", 0) * H)
        host_style = ""
        if c.scale != 1.0 or tuple(c.pos) != (0.0, 0.0):          # the clip's own transform moves the whole layout
            parts = []
            if c.pos[0] or c.pos[1]:
                parts.append(f"translate({px(c.pos[0] * H / 100.0)},{px(-c.pos[1] * H / 100.0)})")
            if c.scale != 1.0:
                parts.append(f"scale({num(round(c.scale, 5))})")
            host_style = "transform:" + " ".join(parts)
        rec, on = c.rec, c.src
        for t, n in a["ranges"]:
            mstart = Fraction(t).limit_denominator(10000)
            spec = {"screen": {"src": src, "media_start": mstart, "style": style}, "bg": bg, "motion": None,
                    "hosting": None}
            if pip:
                at = mstart - Fraction(pip["offset"]).limit_denominator(10000)
                if at < 0:
                    self.warn(f"B-roll {label}: the host circle starts before its A-roll file at "
                              f"{float(Fraction(rec) / fps):.2f} seconds; it starts at the first frame.")
                    at = Fraction(0)
                spec["hosting"] = dict(circle, src=host_src, media_start=at)
            if a.get("motion", "none") != "none":
                spec["motion"] = self._broll_host(src, mstart, Fraction(1), "", a, on, on + n)
            self.items.append(Item("broll", rec, n, label, uses=src, style=host_style,
                                   also=(host_src,) if host_src else (), graphic={"layout": spec}))
            rec += n
            on += n

    def _broll_host(self, src, media_start, rate, style, a, on0, on1):
        """What a B-roll with motion needs for its sub-composition: the same playback as a plain B-roll clip
        plus the zoom or drift the conformed copy had, from mezzanine frame `on0` to `on1` (broll.motion_filter)."""
        W, n, slot, motion = self.W, max(1, a["frames"]), max(1, a.get("slot", 1)), a["motion"]
        k = min(0.12, max(0.03, PUSH * n / slot))
        if motion in ("push", "pull"):
            z = (lambda on: 1 + k * on / n) if motion == "push" else (lambda on: 1 + k * (1 - on / n))
            start, end = (z(on0), 0.0), (z(on1), 0.0)
        elif motion in ("left", "right"):
            frac = (lambda on: on / n) if motion == "right" else (lambda on: 1 - on / n)
            slide = lambda on: (DRIFT_ZOOM - 1) * W * (0.5 - frac(on))  # noqa: E731
            start, end = (DRIFT_ZOOM, slide(on0)), (DRIFT_ZOOM, slide(on1))
        else:
            raise ExportError(f"The B-roll motion {motion!r} is not one of push, pull, left, right or none.")
        return {"src": src, "media_start": media_start, "rate": rate, "style": style, "motion": motion,
                "from": start, "to": end}

    def _sound(self, c, a, kind):
        path = self.tl.path(a["file"])
        folder = "sfx" if kind == "sfx" else "music"
        key = str(path)
        if key not in self.sources:
            dest = f"assets/{folder}/{path.name}"
            self.sources[key] = Source(path.name, dest, None, probe(path), self.fps)
            self.sound_files[dest] = path
        gain = min(self._gain(c), 3.98) if c.volume_db else None
        self.items.append(Item(kind, c.rec, c.dur, c.name or path.name, src=self.sources[key],
                               media_start=Fraction(c.src) / self.fps, volume=gain))

    def _graphic(self, c, a):
        name, label = a["name"], c.name or a["name"]
        var, tpl = {}, None
        if name == "end_fade":
            kind, tpl = "fade", self.project.get("end_template", "end_fade")
        elif name.startswith("hit_"):
            kind, tpl = "hit", self.project.get("hit_template", "hit")
            v = self.hits.get(name, a.get("hit", ""))
            var = dict(v) if isinstance(v, dict) else {"text": v}
        else:
            kind = "overlay" if a.get("alpha", True) else "graphic"
        src_dir = TEMPLATES / tpl if tpl else self.pdir / "gfx_src" / name
        if not (src_dir / "index.html").exists():
            raise ExportError(f"The graphic {name} has no composition: {src_dir / 'index.html'} is missing.")
        if c.src:
            self.warn(f"Graphic {name} resumes {float(Fraction(c.src) / self.fps):.2f} seconds in; "
                      "a project cannot hold that, so it plays from its start.")
        style = ""
        if c.scale != 1.0 or tuple(c.pos) != (0.0, 0.0):
            parts = []
            if c.pos[0] or c.pos[1]:
                parts.append(f"translate({px(c.pos[0] * self.H / 100.0)},{px(-c.pos[1] * self.H / 100.0)})")
            if c.scale != 1.0:
                parts.append(f"scale({num(round(c.scale, 5))})")
            style = "transform:" + " ".join(parts)
        g = {"src_dir": src_dir, "template": tpl or name, "variables": var}
        if not tpl:
            g["meta"] = graphic_record(src_dir)             # what `ve.py graphic` made it from, for edit.json
        self.items.append(Item(kind, c.rec, c.dur, label, style=style, graphic=g))

    # -- ordering, tracks, ids
    def arrange(self):
        fps = self.fps
        self.total = sum(c.dur for c in self.tl.spine)
        keep = []
        for it in self.items:
            if it.start >= self.total:
                self.warn(f"The {it.kind} clip {it.label} starts after the end of the edit and is left out.")
                continue
            if it.end > self.total:
                self.warn(f"The {it.kind} clip {it.label} ends after the A-roll; it is cut at the end of the edit.")
                it.dur = self.total - it.start
            keep.append(it)
        keep.sort(key=lambda i: (i.start, i.end))
        out, last, sound_end = [], {}, []
        for it in keep:
            if it.track >= FIRST_SOUND_TRACK:
                for k, e in enumerate(sound_end):
                    if e <= it.start:
                        sound_end[k] = it.end
                        it.track = FIRST_SOUND_TRACK + k
                        break
                else:
                    it.track = FIRST_SOUND_TRACK + len(sound_end)
                    sound_end.append(it.end)
            else:
                p = last.get(it.track)
                if p is not None and p.end > it.start:
                    self.warn(f"The {p.kind} clips {p.label} and {it.label} overlap at {float(Fraction(it.start) / fps):.2f} "
                              f"seconds on track {it.track}; the first is cut short.")
                    p.dur = it.start - p.start
                    if p.dur < 1:
                        out.remove(p)
                last[it.track] = it
            out.append(it)
        self.items = sorted(out, key=lambda i: (i.track, i.start))
        prefix = {"aroll": "a", "broll": "b", "graphic": "g", "overlay": "ov", "hit": "h", "fade": "fade",
                  "sfx": "s", "music": "m"}
        count = {}
        for it in sorted(self.items, key=lambda i: (i.start, i.track)):
            count[it.kind] = count.get(it.kind, 0) + 1
            it.id = f"{prefix[it.kind]}-{count[it.kind]}"
        self.plan_fades()

    def plan_fades(self):
        """The sound fades of every A-roll clip (fade_plan); the end fade is as long as the end fade picture,
        or, with none, as long as the timeline says the last clip fades out."""
        aroll = sorted((i for i in self.items if i.kind == "aroll"), key=lambda i: i.start)
        picture = [i for i in self.items if i.kind == "fade"]
        end = picture[0].dur if picture else (self.tl.spine[-1].fade_out if self.tl.spine else 0)
        plan = fade_plan([(i.src.path, i.media_start * self.fps, i.rate, i.dur, not i.muted) for i in aroll],
                         self.fps, end)
        for it, (fade_in, fade_out) in zip(aroll, plan):
            it.fade_in, it.fade_out = fade_in, fade_out

    # -- html
    def clip_html(self, it):
        fps = self.fps
        a = [("id", it.id), ("class", "clip")]
        if it.graphic:
            tag = "div"
            a += [("data-composition-id", it.id), ("data-composition-src", f"compositions/{it.id}.html")]
        elif it.kind in ("sfx", "music"):
            tag = "audio"
            a += [("src", it.src.path)]
        else:
            tag = "video"
            a += [("src", it.src.path), ("playsinline", None)]
            a += [("muted", None)] if it.muted else [("data-has-audio", "true")]
        a += [("data-start", seconds(it.start, fps)), ("data-duration", seconds(it.dur, fps))]
        if it.src:
            a.append(("data-media-start", num(it.media_start)))
            if it.rate != 1:
                a.append(("data-playback-rate", num(it.rate)))
        a += [("data-track-index", it.track), ("data-vidai-kind", it.kind), ("data-vidai-label", it.label)]
        if it.graphic:
            a += [("data-width", self.W), ("data-height", self.H)]
            if it.host_values:
                a.append(("data-variable-values", json.dumps(it.host_values, ensure_ascii=False, separators=(",", ":"))))
        if it.volume and it.volume != 1:
            a.append(("data-volume", num(it.volume)))
        if it.fade_in:
            a.append(("data-fade-in", it.fade_in))
        if it.fade_out:
            a.append(("data-fade-out", it.fade_out))
        if tag != "audio":
            a.append(("style", f"z-index:{it.track}" + (";" + it.style if it.style else "")))
        text = " ".join(k if v is None else f'{k}="{attr(v)}"' for k, v in a)
        return f"<{tag} {text}></{tag}>"

    def index_html(self):
        W, H, fps = self.W, self.H, self.fps
        names = {0: "A-roll", 1: "B-roll and full-screen graphics", 2: "Overlays", 3: "Keyword hits", 4: "The end fade"}
        lines, last = [], None
        for it in self.items:
            if it.track != last:
                lines.append(f"      <!-- track {it.track}: {names.get(it.track, 'Sound')} -->")
                last = it.track
            lines.append("      " + self.clip_html(it))
        body = "\n".join(lines)
        script = ROOT_SCRIPT.replace("\r\n", "\n")
        return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width={W}, height={H}" />
    <script src="{GSAP}"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ width: {W}px; height: {H}px; overflow: hidden; background: #000; }}
      #root {{ position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }}
      .clip {{ position: absolute; inset: 0; }}
      video.clip {{ width: 100%; height: 100%; object-fit: cover; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="{W}" data-height="{H}" data-fps="{fps_text(fps)}" data-duration="{seconds(self.total, fps)}">
{body}
    </div>
    <script>
{script}
    </script>
  </body>
</html>
"""

    # -- facts and words
    def edit_json(self):
        used = {(it.src or it.uses).path for it in self.items if it.src or it.uses}
        used |= {x.path for it in self.items for x in it.also}
        try:
            version = (KIT.parent / "VERSION").read_text(encoding="utf-8").strip()
        except OSError:
            version = "0"
        return {
            "toolkitVersion": version, "fps": fps_text(self.fps), "width": self.W, "height": self.H,
            "sources": [{"name": s.name, "path": s.path, "originalPath": s.original, "frames": s.frames,
                         "fps": fps_text(s.fps)}
                        for s in sorted(self.sources.values(), key=lambda s: s.path) if s.path in used],
            "graphics": sorted(self.graphics, key=lambda g: g["id"]),
        }

    def transcript(self):
        """{"words": [{"word", "start", "end"}]}: the spoken words, in seconds on the edited timeline."""
        from .plan import transcript_words
        fps, words, cache = self.fps, [], {}
        for c in self.tl.spine:
            part = c.asset.split(":", 1)[1]
            if part not in cache:
                try:
                    cache[part] = transcript_words(self.pdir, part)
                except (OSError, ValueError, KeyError):
                    cache[part] = []
            t0, t1 = Fraction(c.src) / fps, Fraction(c.src + c.dur) / fps
            at = Fraction(c.rec) / fps
            for w in cache[part]:
                s = Fraction(w["s"]).limit_denominator(10000)
                if t0 <= s < t1:
                    e = min(Fraction(w["e"]).limit_denominator(10000), t1)
                    words.append({"word": w["w"], "start": round(float(at + s - t0), 3), "end": round(float(at + e - t0), 3)})
        words.sort(key=lambda w: (w["start"], w["end"]))
        return {"words": words}


# ------------------------------------------------------------------------------ sub-compositions

VARS_TERNARY = re.compile(r"\(\s*window\.__hyperframes\s*&&\s*window\.__hyperframes\.getVariables\s*\)\s*\?\s*"
                          r"window\.__hyperframes\.getVariables\(\)\s*:\s*\{\}")
URL_IN_CSS = re.compile(r"""url\(\s*(["']?)([^"')]*)\1\s*\)""", re.I)
URL_LOCAL = re.compile(r"(?:[a-z][a-z0-9+.-]*:|//|/|#|shared/|assets/)", re.I)


# -- a graphic page's own look: its page background and text style belong on the graphic's root

PAGE_SELECTORS = {"html", "body", "html body", ":root"}
TEXT_PROPS = ("color", "font", "line-height", "letter-spacing", "word-spacing", "text-align", "text-transform",
              "text-shadow", "text-rendering", "direction", "white-space")
NOT_COLORS = {"transparent", "none", "inherit", "initial", "unset", "revert", "repeat", "no-repeat", "repeat-x",
              "repeat-y", "space", "round", "center", "top", "bottom", "left", "right", "cover", "contain", "auto",
              "fixed", "scroll", "local", "border-box", "padding-box", "content-box", "text", "to", "at", "from"}


def split_top(text, sep):
    """`text` cut at `sep` outside parentheses and quotes."""
    out, depth, quote, cur = [], 0, None, []
    for ch in text:
        if quote:
            quote = None if ch == quote else quote
        elif ch in "\"'":
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif ch == sep and depth == 0:
            out.append("".join(cur))
            cur = []
            continue
        cur.append(ch)
    out.append("".join(cur))
    return out


def declarations(text):
    """[(property, value)] of a style attribute or the inside of a rule."""
    out = []
    for d in split_top(text or "", ";"):
        name, colon, value = d.partition(":")
        if colon and name.strip() and value.strip():
            out.append((name.strip().lower(), value.strip()))
    return out


def css_rules(css):
    """[(start, end, selector text, inside text)] of the rules at the top level of `css` (comments removed);
    a block of an at-rule is one entry whose selector starts with @."""
    out, i = [], 0
    while True:
        j = css.find("{", i)
        if j < 0:
            return out
        depth, k = 1, j + 1
        while k < len(css) and depth:
            depth += {"{": 1, "}": -1}.get(css[k], 0)
            k += 1
        out.append((i, k, css[i:j].rsplit(";", 1)[-1].strip(), css[j + 1:k - 1]))
        i = k


def color_paints(value):
    """False for transparent, none and a colour with alpha 0; True for anything that draws."""
    v = value.lower().replace("!important", "").strip()
    if "var(" in v:
        return True
    v = re.sub(r"(?:linear|radial|conic|repeating-\w+)-gradient\([^)]*(?:\([^)]*\)[^)]*)*\)|url\([^)]*\)", " ", v)
    for m in re.finditer(r"#[0-9a-f]{3,8}\b|(?:rgb|hsl|hwb|lab|lch|oklab|oklch)a?\([^)]*\)|[a-z][a-z-]*", v):
        t = m.group(0)
        if t.startswith("#"):
            if (len(t) == 5 and t[4] == "0") or (len(t) == 9 and t[7:] == "00"):
                continue
            return True
        if "(" in t:
            alpha = re.split(r"[,/]", t[t.index("(") + 1:-1])
            if len(alpha) >= 4 or "/" in t:
                try:
                    if float(alpha[-1].strip().rstrip("%")) == 0:
                        continue
                except ValueError:
                    pass
            return True
        if t not in NOT_COLORS and not re.fullmatch(r"[a-z]*(?:px|em|rem|vw|vh|deg|turn|rad|%)", t):
            return True
    return False


def background_state(decls):
    """(the background declarations that still apply, whether they draw anything) after the cascade of `decls`."""
    kept = []
    for prop, value in decls:
        if prop == "background":
            kept = [("background", value)]
        elif prop.startswith("background-"):
            kept = [(k, v) for k, v in kept if k != prop] + [(prop, value)]
    painted = False
    for prop, value in kept:
        if prop == "background":
            painted = "gradient(" in value.lower() or "url(" in value.lower() or color_paints(value)
        elif prop == "background-color":
            painted = painted or color_paints(value)
        elif prop == "background-image":
            painted = painted or "gradient(" in value.lower() or "url(" in value.lower() or "var(" in value.lower()
    return kept, painted


def page_style(css, html_attrs, body_attrs):
    """Split the page-level rules (`html`, `body`) off `css`.  Returns (css without them, the declarations that
    belong on the graphic's root): the background that shows (the body's over the html's) and the text style."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    layers = {"html": [], "body": []}
    cut = []
    for start, end, sel, inside in css_rules(css):
        names = [re.sub(r"\s+", " ", x.strip().lower()) for x in sel.split(",")]
        if not names or not all(n in PAGE_SELECTORS for n in names):
            continue
        cut.append((start, end))
        d = declarations(inside)
        for n in names:
            layers["body" if "body" in n else "html"].extend(d)
    for tag, attrs in (("html", html_attrs), ("body", body_attrs)):
        m = re.search(r"""\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')""", attrs or "", re.I)
        if m:
            layers[tag].extend(declarations(html.unescape(m.group(1) if m.group(1) is not None else m.group(2))))
    for start, end in reversed(cut):
        css = css[:start] + css[end:]
    body_kept, body_paints = background_state(layers["body"])
    html_kept, html_paints = background_state(layers["html"])
    kept = body_kept if body_paints else html_kept if html_paints else []
    text = {}
    for prop, value in layers["html"] + layers["body"]:
        if prop in TEXT_PROPS or prop.startswith("font-") or prop.startswith("text-"):
            text[prop] = value
    return css, kept + list(text.items())


def outside_ref(ref):
    """The ref of a file that leaves the graphic's own folder (it starts with ..), else None."""
    r = ref.strip().replace("\\", "/")
    if not r or re.match(r"(?:[a-z][a-z0-9+.-]*:|//|/|#)", r, re.I):
        return None
    n = posixpath.normpath(r.split("?")[0].split("#")[0])
    return n if n == ".." or n.startswith("../") else None


def declared_defaults(text):
    m = re.search(r"data-composition-variables='([^']*)'", text) or re.search(r'data-composition-variables="([^"]*)"', text)
    if not m:
        return None
    try:
        return {v["id"]: v.get("default") for v in json.loads(html.unescape(m.group(1))) if "id" in v}
    except (ValueError, TypeError):
        return None


def sub_composition(text, cid, variables, prefix=None, warn=print, outside=None):
    """A graphics page (its root is composition "main") as the sub-composition file of host `cid`.
    The page's background and text style (on html, body or the body's style attribute) move to the root, which
    sits over the host.  `outside(ref)` gives the new place (under `prefix`) of a file beside the graphic's folder.
    Returns (file text, values the script still reads from its host or None)."""
    declared = declared_defaults(text)
    values = dict(declared or {})
    for k, v in (variables or {}).items():
        if declared is not None and k not in declared:
            warn(f"graphic {cid}: ignoring the undeclared variable {k}")
        else:
            values[k] = v
    head = (re.search(r"<head[^>]*>(.*?)</head>", text, re.S | re.I) or (None, ""))[1]
    body = (re.search(r"<body[^>]*>(.*?)</body>", text, re.S | re.I) or (None, text))[1]
    whole = head + "\n" + body
    links = re.findall(r"<link\b[^>]*>", whole, re.I)
    css = "\n".join(re.findall(r"<style\b[^>]*>(.*?)</style>", whole, re.S | re.I))
    css, carried = page_style(css, (re.search(r"<html\b([^>]*)>", text, re.I) or (None, ""))[1],
                              (re.search(r"<body\b([^>]*)>", text, re.I) or (None, ""))[1])
    ext = [s for s in re.findall(r"<script\b[^>]*\bsrc=[^>]*>\s*</script>", whole, re.I) if "gsap" not in s]
    scripts = "\n".join(re.findall(r"<script\b(?![^>]*\bsrc=)[^>]*>(.*?)</script>", body, re.S | re.I))
    markup = re.sub(r"<script\b.*?</script>", "", body, flags=re.S | re.I).strip()
    m = re.search(r'data-composition-id\s*=\s*"([^"]*)"', markup)
    orig = m.group(1) if m else "main"
    root = re.search(r'<\w+\b[^>]*\bdata-composition-id="[^"]*"[^>]*>', markup)
    root_id = (re.search(r'\bid="([^"]+)"', root.group(0)) or (None, "root"))[1] if root else "root"
    # ids unique across the page: prefix every id of the markup (and its uses) with the composition id
    for i in sorted(set(re.findall(r'\bid="([^"]+)"', markup)), key=len, reverse=True):
        new = f"{cid}-{i}"
        e = re.escape(i)
        markup = re.sub(rf'\bid="{e}"', f'id="{new}"', markup)
        css = re.sub(rf"#{e}(?![\w-])", "#" + new, css)
        scripts = re.sub(rf"#{e}(?![\w-])", "#" + new, scripts)
        scripts = re.sub(rf"""getElementById\(\s*(["']){e}\1\s*\)""",
                         lambda mm, n=new: f"getElementById({mm.group(1)}{n}{mm.group(1)})", scripts)

    root_sel = f"#{cid}-{root_id}"
    if carried:
        css = f"{root_sel} {{ " + " ".join(f"{k}: {v};" for k, v in carried) + f" }}\n{css}"

    def root_tag(mm):
        tag = re.sub(r'\s+data-(?:start|duration)="[^"]*"', "", mm.group(0))
        return re.sub(r'data-composition-id="[^"]*"', f'data-composition-id="{cid}"', tag)
    markup = re.sub(r'<\w+\b[^>]*\bdata-composition-id="[^"]*"[^>]*>', root_tag, markup, count=1)
    scripts = re.sub(r"__timelines\[\s*([\"'])" + re.escape(orig) + r"\1\s*\]", f'__timelines["{cid}"]', scripts)
    scripts = VARS_TERNARY.sub("__vars", scripts)
    scripts = scripts.replace("window.__hyperframes.getVariables()", "__vars")
    host_values = values if "getVariables" in scripts else None
    if host_values:
        warn(f"graphic {cid}: its script reads its variables in a way that cannot be filled in; the host carries them.")
    if prefix:                                  # a video's own graphic: its files were copied to assets/gfx/<id>/
        def moved(ref):
            if URL_LOCAL.match(ref.strip()):
                return None
            if outside_ref(ref):                # beside the graphic's folder: the writer copies it in
                new = outside(ref) if outside else None
                return prefix + new if new else None
            return prefix + ref

        def fix(mm):
            new = moved(mm.group(3))
            return mm.group(0) if new is None else f"{mm.group(1)}={mm.group(2)}{new}{mm.group(2)}"

        def fix_url(mm):
            new = moved(mm.group(2))
            return mm.group(0) if new is None else f"url({mm.group(1)}{new}{mm.group(1)})"
        markup = re.sub(r"""\b(src|href)=(["'])(.*?)\2""", fix, markup)
        markup = re.sub(r"""url\((["']?)([^"')]+)\1\)""", fix_url, markup)
        css = re.sub(r"""url\((["']?)([^"')]+)\1\)""", fix_url, css)
        links = [re.sub(r"""\b(href)=(["'])(.*?)\2""", fix, x) for x in links]
    literal = json.dumps(values, ensure_ascii=False).replace("</", "<\\/")
    keep = f"{root_sel} {{ position: absolute; inset: 0; overflow: hidden; }}"
    script = f"(function () {{\nvar __vars = {literal};\n{scripts.strip()}\n}})();"
    out = ["<!doctype html>", '<html lang="en">', '<head><meta charset="UTF-8" /></head>', "<body>", "<template>",
           *links, f"<style>\n{keep}\n{css.strip()}\n</style>", markup, *ext, f"<script>\n{script}\n</script>",
           "</template>", "</body>", "</html>", ""]
    return "\n".join(out), host_values


def inner_frames(src, media_start, rate, dur, fps):
    """How many frames the inner video of a B-roll host lasts: as long as the file allows, but at most
    INNER_EXTRA seconds more than the host (server/src/timeline/editMotion.js innerFrames is the same)."""
    room = math.floor((src.length() - media_start) / rate * fps + Fraction(1, 100))
    return max(dur, min(room, dur + round(INNER_EXTRA * fps)))


def broll_composition(cid, spec, dur, fps, W, H):
    """compositions/<cid>.html of a B-roll with motion: the footage inside a box that zooms or slides
    (the only place where HyperFrames can animate; index.html holds no animation).  Returns (text, variables).

    The inner video plays like a plain B-roll clip (same file, in-point and rate, the static framing of
    place()) and lasts as long as the file allows, so a person can lengthen the host and the picture goes on.
    The movement is the box's data-vidai-motion, scale and slide from and to over `duration` seconds, which the
    file's script reads; the server (editMotion.js) changes it, the video's data-media-start and data-duration,
    and nothing else when it trims, moves or splits the host.  The shape is the same as the one in
    server/test/support/fixtures/projects/motion/, which both sides' tests compare byte for byte."""
    src, rate = spec["src"], spec["rate"]
    inner = inner_frames(src, spec["media_start"], rate, dur, fps)
    (z0, x0), (z1, x1) = spec["from"], spec["to"]
    motion = ('{"scale":[%s,%s],"x":[%s,%s],"duration":%s}'
              % (num(round(z0, 6)), num(round(z1, 6)), num(round(x0, 6)), num(round(x1, 6)), seconds(dur, fps)))
    attrs = [f'id="{cid}-video"', 'class="clip"', f'src="{attr(src.path)}"', "muted", "playsinline", 'data-start="0"',
             f'data-duration="{seconds(inner, fps)}"', f'data-media-start="{num(spec["media_start"])}"']
    if rate != 1:
        attrs.append(f'data-playback-rate="{num(rate)}"')
    attrs.append('data-track-index="0"')
    if spec["style"]:
        attrs.append(f'style="{attr(spec["style"])}"')
    tween = (f'tl.fromTo("#{cid}-motion", {{ scale: m.scale[0], x: m.x[0] }}, '
             '{ scale: m.scale[1], x: m.x[1], duration: m.duration, ease: "none" }, 0);')
    out = ["<!doctype html>", '<html lang="en">', '<head><meta charset="UTF-8" /></head>', "<body>", "<template>",
           "<style>",
           f"#{cid}-root {{ position: absolute; inset: 0; overflow: hidden; }}",
           f"#{cid}-motion {{ position: absolute; inset: 0; transform-origin: 50% 50%; }}",
           f"#{cid}-video {{ position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }}",
           "</style>",
           f'<div id="{cid}-root" data-composition-id="{cid}" data-width="{W}" data-height="{H}">',
           f"  <div id=\"{cid}-motion\" data-vidai-motion='{motion}'>", f"    <video {' '.join(attrs)}></video>",
           "  </div>", "</div>",
           "<script>", "(function () {", "const tl = gsap.timeline({ paused: true });",
           f'const m = JSON.parse(document.getElementById("{cid}-motion").getAttribute("data-vidai-motion"));',
           tween, f'window.__timelines["{cid}"] = tl;', "})();", "</script>", "</template>", "</body>", "</html>", ""]
    variables = {"src": src.path, "mediaStart": float(num(spec["media_start"])), "playbackRate": float(num(rate)),
                 "motion": spec["motion"], "scaleFrom": round(z0, 5), "scaleTo": round(z1, 5),
                 "slideFrom": round(x0, 2), "slideTo": round(x1, 2)}
    return "\n".join(out), variables


# ------------------------------------------------------------------------------ writing the folder

def _inner_video(vid, src, media_start, inner, track, style, extra=""):
    attrs = [f'id="{vid}"', 'class="clip"', f'src="{attr(src.path)}"', "muted", "playsinline", 'data-start="0"',
             f'data-duration="{seconds(inner, 1)}"', f'data-media-start="{num(media_start)}"',
             f'data-track-index="{track}"']
    if style:
        attrs.append(f'style="{attr(style)}"')
    return f"<video {' '.join(attrs)}{extra}></video>"


def layout_composition(cid, spec, dur, fps, W, H):
    """compositions/<cid>.html of a synced B-roll piece with a composed layout (see Exporter._layout_broll):
    the background picture (or black), the screen recording in its box, the host in a round box, all muted,
    and, when the b-roll has motion, the one movement of the whole picture (the conformed copy zoomed the
    composed frame).  Returns (text, variables).  The videos are `<cid>-screen` and `<cid>-host`, never
    `<cid>-video`, so the server edits the host like a graphic and never mistakes it for a B-roll with motion."""
    screen, hosting, motion = spec["screen"], spec["hosting"], spec["motion"]
    layers = []
    if spec["bg"]:
        layers.append(f'<img id="{cid}-bg" src="{attr(spec["bg"])}" alt="" />')
    inner = inner_frames(screen["src"], screen["media_start"], Fraction(1), dur, fps)
    layers.append(_inner_video(f"{cid}-screen", screen["src"], screen["media_start"], Fraction(inner) / fps, 1,
                               screen["style"]))
    css = [f"#{cid}-root {{ position: absolute; inset: 0; overflow: hidden; background: #000; }}",
           f"#{cid}-zoom {{ position: absolute; inset: 0; transform-origin: 50% 50%; }}",
           f"#{cid}-screen {{ position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 1; }}"]
    if spec["bg"]:
        css.insert(2, f"#{cid}-bg {{ position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; z-index: 0; }}")
    variables = {"screen": screen["src"].path, "screenStart": float(num(screen["media_start"])),
                 "background": spec["bg"] or "", "host": "", "hostStart": 0}
    if hosting:
        h_inner = inner_frames(hosting["src"], hosting["media_start"], Fraction(1), dur, fps)
        layers.append(f'<div id="{cid}-pip" style="left:{px(hosting["x"])};top:{px(hosting["y"])};'
                      f'width:{px(hosting["d"])};height:{px(hosting["d"])}">'
                      + _inner_video(f"{cid}-host", hosting["src"], hosting["media_start"], Fraction(h_inner) / fps, 2,
                                     hosting["style"]) + "</div>")
        css += [f"#{cid}-pip {{ position: absolute; overflow: hidden; border-radius: 50%; z-index: 2; }}",
                f"#{cid}-host {{ position: absolute; }}"]
        variables.update(host=hosting["src"].path, hostStart=float(num(hosting["media_start"])))
    zoom_attr, tween = "", ""
    if motion:
        (z0, x0), (z1, x1) = motion["from"], motion["to"]
        value = ('{"scale":[%s,%s],"x":[%s,%s],"duration":%s}'
                 % (num(round(z0, 6)), num(round(z1, 6)), num(round(x0, 6)), num(round(x1, 6)), seconds(dur, fps)))
        zoom_attr = f" data-vidai-layout-motion='{value}'"
        tween = (f'const m = JSON.parse(document.getElementById("{cid}-zoom").getAttribute("data-vidai-layout-motion"));\n'
                 f'tl.fromTo("#{cid}-zoom", {{ scale: m.scale[0], x: m.x[0] }}, '
                 '{ scale: m.scale[1], x: m.x[1], duration: m.duration, ease: "none" }, 0);')
        variables.update(motion=motion_name(motion))
    out = ["<!doctype html>", '<html lang="en">', '<head><meta charset="UTF-8" /></head>', "<body>", "<template>",
           "<style>", *css, "</style>",
           f'<div id="{cid}-root" data-composition-id="{cid}" data-width="{W}" data-height="{H}">',
           f"  <div id=\"{cid}-zoom\"{zoom_attr}>", *["    " + x for x in layers], "  </div>", "</div>",
           "<script>", "(function () {", "const tl = gsap.timeline({ paused: true });"]
    if tween:
        out.append(tween)
    out += [f'window.__timelines["{cid}"] = tl;', "})();", "</script>", "</template>", "</body>", "</html>", ""]
    return "\n".join(out), variables


def motion_name(motion):
    return "zoom" if motion["from"][1] == 0 and motion["to"][1] == 0 else "drift"


def outside_copier(src_dir, dest_dir, cid, warn, limit):
    """The `outside` function of sub_composition for a graphic folder: a file that sits beside the folder
    (../product_images/x.png) is copied to <dest_dir>/_outside/ and its new place returned; None when the
    file is missing or lies outside the video's folder `limit`."""
    src_dir, dest_dir = Path(src_dir), Path(dest_dir)
    done = {}

    def copy(ref):
        target = Path(os.path.normpath(src_dir / outside_ref(ref)))
        if target in done:
            return done[target]
        inside = os.path.realpath(target).startswith(os.path.realpath(limit) + os.sep)
        if not target.is_file() or not inside:
            warn(f"graphic {cid}: the file {ref} is not in the video's folder, so the graphic cannot show it.")
            return None
        parts = [x for x in outside_ref(ref).split("/") if x != ".."]
        name = "/".join(parts)
        n = 1
        while any(v == "_outside/" + name for v in done.values()):
            n += 1
            name = "/".join(parts[:-1] + [f"{n}-{parts[-1]}"])
        dest = dest_dir / "_outside" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, dest)
        done[target] = "_outside/" + name
        return done[target]
    return copy


def write_project(ex, stage):
    stage = Path(stage)
    for d in ("assets/media", "compositions"):
        (stage / d).mkdir(parents=True)
    for s in ex.sources.values():
        if s.original:
            link_media(s.original, stage / s.path)
    for dest, path in ex.layout_files.items():
        link_media(path, stage / dest)
    for dest, path in ex.sound_files.items():
        (stage / dest).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, stage / dest)
    for it in ex.items:
        if not it.graphic:
            continue
        g = it.graphic
        if "layout" in g:
            text, variables = layout_composition(it.id, g["layout"], it.dur, ex.fps, ex.W, ex.H)
            write_text(stage / "compositions" / f"{it.id}.html", text, encoding="utf-8")
            ex.graphics.append({"id": it.id, "template": "broll-layout", "variables": variables, "label": it.label})
            continue
        if "broll" in g:
            text, variables = broll_composition(it.id, g["broll"], it.dur, ex.fps, ex.W, ex.H)
            write_text(stage / "compositions" / f"{it.id}.html", text, encoding="utf-8")
            ex.graphics.append({"id": it.id, "template": "broll-motion", "variables": variables, "label": it.label})
            continue
        prefix = None
        if g["src_dir"].parent != TEMPLATES:                # a video's own graphic keeps its files beside it
            prefix = f"assets/gfx/{it.id}/"
            for p in sorted(g["src_dir"].rglob("*")):
                rel = p.relative_to(g["src_dir"])
                if p.is_file() and rel.as_posix() != "index.html" and not (set(rel.parts) & SKIP_NAMES):
                    (stage / "assets" / "gfx" / it.id / rel).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(p, stage / "assets" / "gfx" / it.id / rel)
        text, it.host_values = sub_composition((g["src_dir"] / "index.html").read_text(encoding="utf-8"), it.id,
                                               g["variables"], prefix, ex.warn,
                                               outside_copier(g["src_dir"], stage / "assets" / "gfx" / it.id, it.id, ex.warn, ex.pdir.parent)
                                               if prefix else None)
        write_text(stage / "compositions" / f"{it.id}.html", text, encoding="utf-8")
        meta = g.get("meta") or {"template": g["template"], "variables": g["variables"]}
        ex.graphics.append({"id": it.id, "template": meta["template"], "variables": meta["variables"], "label": it.label})
    shutil.copytree(SHARED, stage / "shared", ignore=shutil.ignore_patterns(".DS_Store", "Thumbs.db"))
    write_text(stage / "index.html", ex.index_html(), encoding="utf-8")
    write_text(stage / "edit.json", json.dumps(ex.edit_json(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write_text(stage / "transcript.json", json.dumps(ex.transcript(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    write_text(stage / "hyperframes.json", json.dumps({
        "$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
        "registry": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
        "paths": {"blocks": "compositions", "components": "compositions/components", "assets": "assets"},
        "media": {"autoProxy": True}}, indent=2) + "\n", encoding="utf-8")


def swap(stage, target):
    """Put the finished folder in place of the old project; the old one is removed only after the new one is in."""
    stage, target = Path(stage), Path(target)
    old = target.with_name(target.name + ".old")
    if old.exists() or old.is_symlink():
        shutil.rmtree(old, ignore_errors=True)
    had = target.exists() or target.is_symlink()
    if had:
        os.replace(target, old)
    try:
        os.replace(stage, target)
    except OSError:
        if had:
            os.replace(old, target)
        raise
    if had:
        shutil.rmtree(old, ignore_errors=True)


# ------------------------------------------------------------------------------ the self check

class _Index(HTMLParser):
    VOID = {"meta", "link", "img", "br", "hr", "input", "source", "area", "base", "col", "embed", "track", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth, self.root_depth = 0, None
        self.root, self.clips, self.scripts, self.refs = None, [], [], []
        self._script = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script":
            self._script = {"src": a.get("src"), "text": ""}
            self.scripts.append(self._script)
        else:
            for k in ("src", "href", "data-composition-src"):
                if a.get(k) is not None:
                    self.refs.append((a.get("id") or tag, a[k]))
        if a.get("id") == "root" and self.root is None:
            self.root, self.root_depth = a, self.depth
        elif self.root is not None and self.depth == self.root_depth + 1:
            self.clips.append((tag, a))
        if tag not in self.VOID:
            self.depth += 1

    def handle_endtag(self, tag):
        if tag == "script":
            self._script = None
        if tag not in self.VOID:
            self.depth -= 1

    def handle_data(self, data):
        if self._script is not None:
            self._script["text"] += data


class _Comp(HTMLParser):
    """A composition file: its elements (tag, attributes, parent), the file references and the CSS text."""
    VOID = _Index.VOID

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.elements, self.refs, self.css, self._stack, self._style = [], [], [], [], False

    def handle_starttag(self, tag, attrs):
        a = {k: (v if v is not None else "") for k, v in attrs}
        if tag == "style":
            self._style = True
            self.css.append("")
        elif tag != "script":
            self.elements.append({"tag": tag, "a": a, "parent": self._stack[-1] if self._stack else None})
            if a.get("style"):
                self.css.append("")
        for k in ("src", "href", "data-composition-src"):
            if a.get(k):
                self.refs.append(a[k])
        for m in URL_IN_CSS.finditer(a.get("style") or ""):
            self.refs.append(m.group(2))
        if tag not in self.VOID and tag not in ("style", "script"):
            self._stack.append(len(self.elements) - 1)

    def handle_endtag(self, tag):
        if tag == "style":
            self._style = False
        elif tag not in self.VOID and tag != "script" and self._stack:
            self._stack.pop()

    def handle_data(self, data):
        if self._style:
            self.css[-1] += data
            self.refs.extend(m.group(2) for m in URL_IN_CSS.finditer(data))
            self.refs.extend(m.group(2) for m in re.finditer(r"""@import\s+(["'])(.*?)\1""", data))

    def declared(self, i):
        """The declarations that apply to element i from rules with a plain #id or .class selector, then its style."""
        a = self.elements[i]["a"]
        ids, classes = {a.get("id")} - {None, ""}, set((a.get("class") or "").split())
        out = []
        for chunk in self.css:
            for _, _, sel, inside in css_rules(re.sub(r"/\*.*?\*/", "", chunk, flags=re.S)):
                for one in sel.split(","):
                    one = one.strip()
                    if (one[:1] == "#" and one[1:] in ids) or (one[:1] == "." and one[1:] in classes):
                        out.extend(declarations(inside))
                        break
        return out + declarations(html.unescape(a.get("style") or ""))


def covers_frame(decls, W, H):
    """Whether the declarations make a box that covers the whole frame (inset 0, or full width and height)."""
    d = dict(decls)
    zero = lambda v: bool(re.fullmatch(r"0+(?:\.0+)?(?:px|%)?", (v or "").strip()))  # noqa: E731
    if d.get("position") in ("absolute", "fixed"):
        if d.get("inset") and all(zero(x) for x in d["inset"].split()):
            return True
        if all(zero(d.get(k)) for k in ("top", "left", "right", "bottom")):
            return True

    def full(v, edge):
        v = (v or "").strip().lower()
        m = re.fullmatch(r"([\d.]+)px", v)
        return v in ("100%", "100vw" if edge == W else "100vh") or bool(m and float(m.group(1)) >= edge)
    return full(d.get("width"), W) and full(d.get("height"), H)


def hides_the_video(folder, cid, W, H):
    """False when the composition of a full-screen graphic has no opaque background over the frame."""
    try:
        c = _Comp()
        c.feed((Path(folder) / "compositions" / f"{cid}.html").read_text(encoding="utf-8"))
    except OSError:
        return True
    roots = [i for i, e in enumerate(c.elements) if e["a"].get("data-composition-id") == cid]
    if not roots:
        return True
    root = roots[0]
    if background_state(c.declared(root))[1]:
        return True
    first = next((i for i, e in enumerate(c.elements) if e["parent"] == root), None)
    if first is None:
        return False
    if c.elements[first]["tag"] in ("video", "img", "canvas"):      # a picture or footage as the card
        return True
    d = c.declared(first)
    return background_state(d)[1] and covers_frame(d, W, H)


def reference_problem(value):
    """"path" when a reference is no relative path inside the project, else None (a data: URL and #fragment are fine)."""
    v = value.strip()
    if not v or v.startswith("#") or v.lower().startswith("data:"):
        return None
    if re.match(r"(?:[a-z][a-z0-9+.-]*:|//|/)", v, re.I) or "\\" in v:
        return "path"
    n = posixpath.normpath(v.split("?")[0].split("#")[0])
    return "path" if n == ".." or n.startswith("../") else None


def motion_problems(folder, cid, dur, fps, sources):
    """Rule 7 of a B-roll host with motion: its video is in compositions/<cid>.html (the sentences are
    those of the server's profile.js)."""
    try:
        text = (Path(folder) / "compositions" / f"{cid}.html").read_text(encoding="utf-8")
    except OSError:
        return []
    video = re.search(r"<video\b([^>]*)>", text)
    if not re.search(r"data-vidai-motion='[^']*'", text) or not video:
        return []
    a = dict(re.findall(r'([\w-]+)="([^"]*)"', video.group(1)))
    who = f'The host "{cid}"'
    s = sources.get(a.get("src"))
    if s is None:
        return [f"Rule 7: {who} plays {a.get('src')} in compositions/{cid}.html, which edit.json does not list under sources."]
    try:
        ms, inner = Fraction(a.get("data-media-start", "0")), Fraction(a["data-duration"])
        rate = Fraction(a.get("data-playback-rate", "1"))
    except (KeyError, ValueError, ZeroDivisionError):
        return [f"Rule 7: the video in compositions/{cid}.html needs numeric data-media-start and data-duration."]
    length = Fraction(s["frames"]) / Fraction(str(s["fps"]))
    if rate <= 0 or ms < 0 or ms + dur * rate > length + Fraction(1, 100) / fps:
        return [f"Rule 7: {who} plays seconds {float(ms):.3f} to {float(ms + dur * rate):.3f} of "
                f"{s['name']}, which is {float(length):.3f} seconds long."]
    if inner * fps + Fraction(1, 100) < dur * fps:
        return [f"Rule 7: the video in compositions/{cid}.html lasts {float(inner):.3f} seconds, shorter than {who}."]
    return []


def layout_problems(folder, cid, dur, fps, sources):
    """Rule 7 for the videos of a layout host (compositions/<cid>.html written by layout_composition)."""
    try:
        text = (Path(folder) / "compositions" / f"{cid}.html").read_text(encoding="utf-8")
    except OSError:
        return []
    out = []
    for m in re.finditer(r"<video\b([^>]*)>", text):
        a = dict(re.findall(r'([\w-]+)="([^"]*)"', m.group(1)))
        if not str(a.get("id", "")).startswith(f"{cid}-") or "muted" not in m.group(1).split():
            continue
        s = sources.get(a.get("src"))
        if s is None:
            out.append(f"Rule 7: the host \"{cid}\" plays {a.get('src')} in compositions/{cid}.html, which edit.json "
                       "does not list under sources.")
            continue
        ms, rate = Fraction(a.get("data-media-start", "0")), Fraction(a.get("data-playback-rate", "1"))
        length = Fraction(s["frames"]) / Fraction(str(s["fps"]))
        if ms < 0 or ms + dur * rate > length + Fraction(1, 100) / fps:
            out.append(f"Rule 7: the host \"{cid}\" plays seconds {float(ms):.3f} to {float(ms + dur * rate):.3f} of "
                       f"{s['name']}, which is {float(length):.3f} seconds long.")
    return out


def check_project(folder):
    """Rules 1 to 7 and 10 of the profile (SPEC section 10) for index.html and the composition files, the host rule 8
    and rule 12 (a full-screen graphic has an opaque background), as plain sentences;
    an empty list is a pass."""
    folder = Path(folder)
    bad = []
    try:
        edit = json.loads((folder / "edit.json").read_text(encoding="utf-8"))
        p = _Index()
        p.feed((folder / "index.html").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return [f"The project cannot be read: {e}."]
    root = p.root
    if root is None:
        return ["index.html has no element with id root."]
    try:
        fps = Fraction(root.get("data-fps"))
        total = Fraction(root["data-duration"])
    except (TypeError, ValueError, ZeroDivisionError, KeyError):
        return ["Rule 1: the root needs numeric data-fps and data-duration."]
    if root.get("data-composition-id") != "main" or root.get("data-start") != "0":
        bad.append('Rule 1: the root must have data-composition-id="main" and data-start="0".')
    size = (root.get("data-width"), root.get("data-height"))
    if size not in (("1920", "1080"), ("1080", "1920")):
        bad.append(f"Rule 1: the root is {size[0]} by {size[1]}; it must be 1920 by 1080 or 1080 by 1920.")
    if (str(edit.get("width")), str(edit.get("height"))) != size or Fraction(str(edit.get("fps"))) != fps:
        bad.append("Rule 1: the root's size or frame rate differs from edit.json.")
    sources = {s["path"]: s for s in edit.get("sources", [])}
    ids, tracks, full_screen = set(), {}, []
    for tag, a in p.clips:
        cid = a.get("id")
        who = f'The {tag} "{cid or "?"}"'
        if not cid or cid in ids:
            bad.append(f"Rule 3: {who} has a missing or repeated id.")
        ids.add(cid)
        if "clip" not in (a.get("class") or "").split():
            bad.append(f'Rule 3: {who} lacks class="clip".')
        try:
            texts = (a["data-start"], a["data-duration"])
            start, dur = Fraction(texts[0]), Fraction(texts[1])
        except (KeyError, ValueError):
            bad.append(f"Rule 3: {who} has no numeric data-start and data-duration.")
            continue
        for t in texts:
            if "." in t and len(t.split(".")[1]) > DECIMALS:
                bad.append(f"Rule 3: {who} writes a time with more than {DECIMALS} decimals.")
        for t in (start, dur):
            if abs(t * fps - round(t * fps)) > Fraction(1, 100):
                bad.append(f"Rule 3: {who} has a time that is not on a frame boundary.")
        kind = a.get("data-vidai-kind")
        if kind not in KINDS:
            bad.append(f"Rule 3: {who} has the kind {kind!r}.")
            continue
        if not (a.get("data-vidai-label") or "").strip():
            bad.append(f"Rule 3: {who} has no data-vidai-label.")
        try:
            track = int(a["data-track-index"])
        except (KeyError, ValueError):
            bad.append(f"Rule 3: {who} has no data-track-index.")
            continue
        if (TRACK[kind] != track) if kind in TRACK else (track < FIRST_SOUND_TRACK):
            bad.append(f"Rule 4: {who} of the kind {kind} sits on track {track}.")
        if tag != "audio":
            z = re.search(r"(?:^|;)\s*z-index\s*:\s*(-?\d+)", a.get("style") or "")
            if not z or int(z.group(1)) != track:
                bad.append(f"Rule 4: {who} must have z-index:{track} in its style.")
        tracks.setdefault(track, []).append((start, start + dur, cid))
        if start + dur > total:
            bad.append(f"Rule 5: {who} ends after the root's duration.")
        if tag in ("video", "audio"):
            s = sources.get(a.get("src"))
            if s is None:
                bad.append(f"Rule 7: {who} plays {a.get('src')}, which edit.json does not list under sources.")
            else:
                ms = Fraction(a.get("data-media-start", "0"))
                used = ms + dur * Fraction(a.get("data-playback-rate", "1"))
                length = Fraction(s["frames"]) / Fraction(str(s["fps"]))
                if ms < 0 or used > length + Fraction(1, 100) / fps:
                    bad.append(f"Rule 7: {who} plays seconds {float(ms):.3f} to {float(used):.3f} of "
                               f"{s['name']}, which is {float(length):.3f} seconds long.")
        if a.get("data-composition-src") is not None and (
                a["data-composition-src"] != f"compositions/{cid}.html" or a.get("data-composition-id") != cid):
            bad.append(f"Rule 8: the host {cid} must show compositions/{cid}.html and have that id as its composition id.")
        elif a.get("data-composition-src") is not None:
            bad += motion_problems(folder, cid, dur, fps, sources)
            bad += layout_problems(folder, cid, dur, fps, sources)
            if kind == "graphic":
                full_screen.append(cid)
    aroll = sorted(tracks.get(0, []))
    if not aroll or aroll[0][0] != 0:
        bad.append("Rule 5: the A-roll does not start at 0.")
    for x, y in zip(aroll, aroll[1:]):
        if y[0] != x[1]:
            bad.append(f"Rule 5: the A-roll has {'a gap' if y[0] > x[1] else 'an overlap'} between {x[2]} and {y[2]}.")
    if aroll and aroll[-1][1] != total:
        bad.append("Rule 5: the root's data-duration is not the end of the last A-roll clip.")
    for track, clips in tracks.items():
        clips.sort()
        for x, y in zip(clips, clips[1:]):
            if y[0] < x[1]:
                bad.append(f"Rule 6: {x[2]} and {y[2]} overlap on track {track}.")
    for who, value in p.refs:
        v = value.strip()
        if re.match(r"(?:[a-z][a-z0-9+.-]*:|//|/)", v, re.I) or ".." in re.split(r"[\\/]", v):
            bad.append(f"Rule 10: {who} has the path {value}, which is not a relative path inside the project.")
        elif not (folder / v).exists():
            bad.append(f"Rule 10: {who} refers to {value}, which is not in the project.")
    for f in sorted((folder / "compositions").glob("*.html")):
        c = _Comp()
        try:
            c.feed(f.read_text(encoding="utf-8"))
        except OSError:
            continue
        who = f"compositions/{f.name}"
        for value in dict.fromkeys(c.refs):
            if reference_problem(value):
                bad.append(f"Rule 10: {who} has the path {value}, which is not a relative path inside the project.")
            elif value.strip() and not value.strip().startswith(("#", "data:")) and \
                    not (folder / value.strip().split("?")[0].split("#")[0]).exists():
                bad.append(f"Rule 10: {who} refers to {value}, which is not in the project.")
    for cid in full_screen:
        if not hides_the_video(folder, cid, int(size[0]), int(size[1])):
            bad.append(f"Rule 12: the full-screen graphic {cid} has no opaque background over the whole frame, "
                       "so the video shows through it; give its page a background color or image.")
    inline = [s for s in p.scripts if s["src"] is None]
    for s in p.scripts:
        if s["src"] is not None and (not s["src"].startswith("shared/") or ".." in s["src"]):
            bad.append(f"Rule 9: the script {s['src']} is not a file of shared/.")
        elif s["src"] is not None and not (folder / s["src"]).exists():
            bad.append(f"Rule 10: the script {s['src']} is not in the project.")
    if len(inline) != 1 or inline[0]["text"].replace("\r\n", "\n").strip() != ROOT_SCRIPT.replace("\r\n", "\n").strip():
        bad.append("Rule 9: index.html must hold exactly VidAI's root script and no other inline script.")
    return bad


# ------------------------------------------------------------------------------ the command

def export(main, tl=None, log=print):
    """Write <video>/output/<video folder name>.hf/ and return its path; raises ExportError."""
    ex = Exporter(main, tl, log)
    out_dir = ex.vdir / "output"
    target = out_dir / f"{ex.vdir.name}.hf"
    ex.build_items()
    if not [i for i in ex.items if i.kind == "aroll"]:
        raise ExportError("The timeline has no A-roll.")
    ex.arrange()
    out_dir.mkdir(parents=True, exist_ok=True)
    stage = out_dir / f".{target.name}.new"
    if stage.exists() or stage.is_symlink():
        shutil.rmtree(stage, ignore_errors=True)
    try:
        write_project(ex, stage)
        old = ex._json(target / "meta.json", {}) if target.exists() else {}
        write_text(stage / "meta.json", json.dumps({
            "id": re.sub(r"[^a-z0-9]+", "-", ex.vdir.name.lower()).strip("-") or "video", "name": ex.vdir.name,
            "createdAt": old.get("createdAt") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")},
            indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        problems = check_project(stage)
        if problems:
            raise ExportError("The project does not follow the rules:\n  " + "\n  ".join(problems[:20]))
        swap(stage, target)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    kinds = {}
    for i in ex.items:
        kinds[i.kind] = kinds.get(i.kind, 0) + 1
    log(f"project {ex.W}x{ex.H} at {fps_text(ex.fps)}, {float(ex.total / ex.fps):.2f} seconds: "
        + ", ".join(f"{n} {k}" for k, n in sorted(kinds.items())))
    log("self check: OK")
    return target
