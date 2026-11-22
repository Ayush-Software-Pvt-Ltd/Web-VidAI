"""Turn a project's timeline.py (raw-time edit decisions) into a frame-accurate Timeline.

Raw times are seconds in an A-roll file.  A project can have several A-roll parts
(project.json "aroll": {"a1": file, "a2": file}); every raw time may name its part as a
leading string, otherwise it is in "a1".

timeline.py exports:
  SEGS      [([part,] raw_in, raw_out[, {"in": "exact", "out": "exact"}]), ...] kept A-roll
            in output order; raw_in = first word start, raw_out = last word END; "exact"
            pins a hand-verified cut point (no snapping)
  VIS       [([part,] raw_anchor, kind), ...] picture from that point until the next entry:
              "H"  host, framing auto-alternates across cuts
              "HW" host wide, "HT" host tight (punch-in), forced
              "G:<name>[@<sec>]" full-screen graphic from gfx_src/<name> (optional in-point, to
                    resume a graphic after a cut to the host)
              "B:<id>[@<sec>]" b-roll footage from BROLL[id] (optional in-point override);
                    a BROLL entry with "sync" follows the A-roll (see broll.py)
  BROLL     {id: {"file": path in the video folder, "in": sec, "lo"/"hi": usable window,
            "motion": "push"|"pull"|"left"|"right"|"none", optional "scale"/"pos" = FCP transform
            to reframe the shot}} footage used by "B:" entries
  OVL       [([part,] raw_t0, raw_t1, name), ...] transparent overlay graphics (lane 2),
            e.g. spec cards over b-roll
  HITS      [([part,] raw_t0, raw_t1, text[, {variables}]), ...] keyword pop-ups (lane 3),
            rendered from the project's "hit_template"
  SFX       [([part,] raw_t, name, db), ...] extra sound effects
  END_HOLD  seconds of quiet kept after the last word (fade to black over it)
Anchors that fall in removed audio map to the next kept frame.
"""
import hashlib
import importlib.util
import json
import re
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from . import broll, tools
from .model import DEFAULT_FPS, Clip, Rate, Timeline
from .paths import SFX as SFX_DIR, project_dir, rel, video_dir

WIDE = (1.0, (0.0, 0.0))
# lanes: full-screen 1, overlays 2; pop-ups and the end fade default to 2 and 3 (older
# projects) and move up with project "hit_lane"/"end_lane" when overlays are used
LANE_FULL, LANE_OVL, LANE_HIT, LANE_END = 1, 2, 2, 3


def tight_framing(project, W, H):
    """Punch-in (~118%) that keeps an anchor point of the frame where it was.

    project "tight_anchor": [x, y] as fractions of the frame (e.g. the face); default is the
    top of the head ("head_top", centred).  FCP scales about the frame centre, so the
    picture is moved back by the drift of the anchor, clamped so it still covers the frame."""
    s = project.get("tight_scale", 1.18)
    ax, ay = project.get("tight_anchor", [0.5, project.get("head_top", 0.235)])
    dx = (ax - 0.5) * W * (1 - s)                    # pixels, +x right
    dy = (ay - 0.5) * H * (1 - s)                    # pixels, +y down
    mx, my = W * (s - 1) / 2, H * (s - 1) / 2
    dx, dy = max(-mx, min(mx, dx)), max(-my, min(my, dy))
    return (s, (round(dx / H * 100, 3), -round(dy / H * 100, 3)))


def load_module(path):
    spec = importlib.util.spec_from_file_location("timeline_" + hashlib.md5(str(path).encode()).hexdigest()[:6], path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def transcript_words(pdir, part="a1"):
    """All chunk-pass words of one part (loops filtered), sorted, for neighbour-aware cuts."""
    out = []
    for c in json.loads((pdir / "transcripts" / f"{part}.chunks.json").read_text(encoding="utf-8"))["chunks"]:
        ws = c["words"]
        if len(ws) > 6 and len({w["w"] for w in ws}) <= 3:
            continue                                   # a repetition loop, not speech
        out += [w for w in ws if w["e"] - w["s"] > 0.0]
    return sorted(out, key=lambda w: w["s"])


def gfx_duration_frames(src_dir, rate):
    html = (src_dir / "index.html").read_text(encoding="utf-8")
    m = re.search(r'data-composition-id="main"[^>]*?data-duration="([\d.]+)"', html, re.S) or \
        re.search(r'data-duration="([\d.]+)"', html)
    return rate.gfx_frames(float(m.group(1)))


def source_timecode(path, rate):
    """Start timecode of a camera file in frames, as Final Cut Pro sees it: only a QuickTime
    timecode track ("tmcd") counts.  Sony XAVC MP4 keeps its timecode in an "rtmd" metadata
    stream that FCP ignores (the 6981 import failed with "Invalid edit with no respective media"
    when in-points were offset by it), so such files start at 0.  FCPXML in-points of the
    original file are offset by the result.  "HH:MM:SS:FF" is non-drop; "HH:MM:SS;FF" drop-frame."""
    out = subprocess.run([tools.ffprobe(), "-v", "error", "-show_entries", "stream=codec_tag_string:stream_tags=timecode",
                          "-of", "json", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace", check=True).stdout
    info = json.loads(out)
    tc = next((st["tags"]["timecode"] for st in info.get("streams", [])
               if st.get("codec_tag_string") == "tmcd" and st.get("tags", {}).get("timecode")), None)
    if not tc:
        return 0
    h, m, sec, f = (int(v) for v in re.split(r"[:;.]", tc))
    nom = round(float(rate.fps))
    frames = ((h * 60 + m) * 60 + sec) * nom + f
    if ";" in tc:
        drop = 2 * nom // 30
        minutes = 60 * h + m
        frames -= drop * (minutes - minutes // 10)
    return frames


def split_part(entry):
    """([part,] rest...) -> (part, rest)."""
    if entry and isinstance(entry[0], str):
        return entry[0], tuple(entry[1:])
    return "a1", tuple(entry)


class Energy:
    """10 ms RMS envelope of the A-roll (mono) for snapping cut points to quiet audio."""

    def __init__(self, wav, thr_db=None):
        x, sr = sf.read(str(wav), dtype="float32")
        if x.ndim > 1:
            x = x.mean(axis=1)
        hop = sr // 100
        n = len(x) // hop
        rms = np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)
        self.db = 20 * np.log10(rms)
        self.floor = float(np.percentile(self.db, 10))
        # project "energy_threshold_db": absolute quiet threshold for noisy rooms (a fan lifts
        # pauses well above floor + 10 dB); default floor + 10 dB
        self.thr = float(thr_db) if thr_db is not None else self.floor + 10.0

    def quiet(self, t0, t1):
        a, b = int(t0 * 100), int(np.ceil(t1 * 100))
        seg = self.db[max(0, a):max(a + 1, b)]
        return bool(len(seg)) and bool((seg < self.thr).all())

    def snap_out(self, t, limit=0.40, hold=0.08):
        """First point after t where the next `hold` seconds are quiet."""
        s = t
        while s < t + limit:
            if self.quiet(s, s + hold):
                return s + 0.03
            s += 0.01
        return t + 0.08

    def valley(self, t0, t1):
        """Centre of the quietest 30 ms between t0 and t1 (a cut point between touching words)."""
        a, b = int(t0 * 100), int(np.ceil(t1 * 100))
        seg = self.db[a:b]
        if len(seg) < 3:
            return (t0 + t1) / 2
        sm = np.convolve(seg, np.ones(3) / 3, mode="same")
        return (a + int(np.argmin(sm[1:-1])) + 1) / 100 + 0.005

    def split_pauses(self, t0, t1, min_pause, pad=0.07):
        """Split [t0, t1] around quiet runs longer than min_pause (keeps `pad` on each side)."""
        a, b = int(t0 * 100), int(t1 * 100)
        q = self.db[a:b] < self.thr
        out, start, k = [], t0, 0
        while k < len(q):
            if q[k]:
                j = k
                while j < len(q) and q[j]:
                    j += 1
                if (j - k) / 100 >= min_pause and k > 0 and j < len(q):
                    out.append((start, (a + k) / 100 + pad))
                    start = (a + j) / 100 - pad
                k = j
            else:
                k += 1
        out.append((start, t1))
        return out

    def snap_in(self, t, limit=0.30, hold=0.08):
        """Last point before t where the previous `hold` seconds are quiet."""
        s = t
        while s > t - limit:
            if self.quiet(s - hold, s):
                return s - 0.03
            s -= 0.01
        return t - 0.06


def plan(main, write=True):
    """`main` is the video folder (absolute, or relative to the current directory)."""
    vdir = video_dir(main)
    pdir = project_dir(vdir)
    project = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    mod = load_module(pdir / "timeline.py")
    W, H = project.get("width", 2160), project.get("height", 3840)
    rate = Rate(project.get("fps", DEFAULT_FPS))
    f2s, s2f = rate.f2s, rate.s2f
    parts = project["aroll"]
    frames_of = project["aroll_frames"]
    if not isinstance(frames_of, dict):
        frames_of = {"a1": frames_of}
    energy, words = {}, {}
    warns = []

    # ---- 1. segments: snap to quiet audio between words, split out long pauses,
    #         frame-align, merge near-contiguous pieces of the same part
    split_at = getattr(mod, "SPLIT_PAUSES", 0.30)
    pieces = []
    for seg in mod.SEGS:
        part, rest = split_part(seg)
        if part not in energy:
            energy[part] = Energy(pdir / "audio" / f"{part}_48k.wav", project.get("energy_threshold_db"))
            words[part] = transcript_words(pdir, part)
        en, ws = energy[part], words[part]
        a, b = rest[0], rest[1]
        opts = rest[2] if len(rest) > 2 else {}
        prev_end = max((w["e"] for w in ws if w["s"] < a - 0.05), default=0.0)
        next_start = min((w["s"] for w in ws if w["s"] > b - 0.01 and w["e"] > b + 0.02), default=b + 5)
        if a - prev_end < 0.15:                       # words touch: cut at the quietest point between them
            i = en.valley(prev_end - 0.10, a + 0.05)
        else:
            i = max(en.snap_in(a), prev_end + 0.02)
        if next_start - b < 0.15:
            o = en.valley(b - 0.05, next_start + 0.10)
        else:
            o = min(en.snap_out(b), next_start - 0.02)
        if opts.get("in") == "exact":                 # hand-verified cut point: no snapping
            i = a
        if opts.get("out") == "exact":
            o = b
        for x, y in en.split_pauses(i, o, split_at):
            pieces.append([part, s2f(max(0.0, x)), s2f(y)])
    merged = []
    for s in pieces:
        same = merged and merged[-1][0] == s[0]
        if same and 0 <= s[1] - merged[-1][2] <= 3:
            merged[-1][2] = max(merged[-1][2], s[2])
        elif same and merged[-1][1] < s[1] < merged[-1][2]:
            merged[-1][2] = max(merged[-1][2], s[2])     # overlapping consecutive pieces
        else:
            merged.append(s)
    end_hold = s2f(getattr(mod, "END_HOLD", 0.55))
    merged[-1][2] += end_hold

    rec = []
    t = 0
    for part, i, o in merged:
        rec.append((t, part, i, o))
        t += o - i
    total = t

    def raw2rec(part, seconds):
        """Record frame of a raw time; inside removed audio -> the next kept frame of that part
        (in raw order), else the end."""
        f = s2f(seconds)
        for r0, p, i, o in rec:
            if p == part and i <= f < o:
                return r0 + (f - i)
        later = [(i, r0) for r0, p, i, o in rec if p == part and i > f]
        return min(later)[1] if later else total

    def anchor(entry):
        part, rest = split_part(entry)
        return part, rest

    cut_points = sorted({r0 for r0, _, _, _ in rec} | {total})

    def snap_to_cut(r, near=8):
        """Anchors a few frames from a jump cut move onto it (no slivers)."""
        c = min(cut_points, key=lambda c: abs(c - r))
        return c if abs(c - r) <= near else r

    # ---- 2. picture intervals from VIS
    vis = []
    for e in mod.VIS:
        part, (t0, k) = anchor(e)
        vis.append((snap_to_cut(raw2rec(part, t0)), k))
    vis.sort(key=lambda x: x[0])
    import os
    if os.environ.get("VE_DEBUG_VIS"):
        print("VIS:", [(r, k) for r, k in vis])
    if not vis or vis[0][0] != 0:
        vis.insert(0, (0, "H"))
    ivals = []
    for n, (r, k) in enumerate(vis):
        e = vis[n + 1][0] if n + 1 < len(vis) else total
        if e > r:
            ivals.append([r, e, k])

    def cover(k):
        return k.startswith("G:") or k.startswith("B:")

    # host shots = host intervals split at jump cuts (segment starts)
    cuts = {r0 for r0, _, _, _ in rec}

    # a cover shot that ends a fraction of a second before a jump cut would leave a host flash:
    # run the graphic / tablet to that cut instead (the last frames of a graphic hold safely)
    min_host = s2f(0.6)
    kept = []
    for n, (r, e, k) in enumerate(ivals):
        if cover(k) and n + 1 < len(ivals) and not cover(ivals[n + 1][2]):
            nr, ne, _ = ivals[n + 1]
            first = min([c for c in cuts if nr < c < ne], default=ne)
            if first - nr < min_host:
                e = first
                ivals[n + 1][0] = first
        kept.append([r, e, k])
    ivals = [iv for iv in kept if iv[1] > iv[0]]
    shots = []
    for r, e, k in ivals:
        if cover(k):
            shots.append([r, e, k])
            continue
        pts = sorted({r, e} | {c for c in cuts if r < c < e})
        for a, b in zip(pts, pts[1:]):
            shots.append([a, b, k])
    tight = tight_framing(project, W, H)
    last = WIDE
    framing = []
    for a, b, k in shots:
        if cover(k):
            continue
        if k == "HW":
            f = WIDE
        elif k == "HT":
            f = tight
        else:
            f = tight if last == WIDE else WIDE
        framing.append((a, b, f))
        last = f
    # project "min_framing_frames": a host piece shorter than this between jump cuts takes the
    # framing of the neighbouring piece of the same host run (one unhidden jump cut instead of
    # a wide/tight flash); 0 = off
    minf = project.get("min_framing_frames", 0)
    for n, (a, b, f) in enumerate(framing):
        if b - a >= minf:
            continue
        nxt = framing[n + 1] if n + 1 < len(framing) and framing[n + 1][0] == b else None
        prv = framing[n - 1] if n > 0 and framing[n - 1][1] == a else None
        if nxt or prv:
            framing[n] = (a, b, (nxt or prv)[2])
    for a, b, f in framing:
        if b - a < 12:
            warns.append(f"short host shot {f2s(a):.2f}-{f2s(b):.2f}s ({b - a} frames)")

    # ---- 3. spine: segments split wherever the host framing changes
    tl = Timeline(width=W, height=H, fps=rate.ff, base=vdir)
    for part, fname in parts.items():
        # FCP links the original camera file (creator's rule, 2026-10-29: no ProRes or remuxed
        # copies of the A-roll); FCP applies its rotation flag itself and its timecode is
        # added to every FCPXML in-point ("tc_start")
        tl.assets[f"aroll:{part}"] = {
            "kind": "aroll", "file": rel(vdir / fname, vdir),
            "fcp_file": rel(vdir / fname, vdir),
            "tc_start": source_timecode(pdir.parent / fname, rate),
            "audio": rel(pdir / "audio" / f"{part}_48k.wav", vdir),
            "frames": frames_of[part], "w": W, "h": H,
        }
        # camera files filmed sideways without a rotation flag (project.json "aroll_rotate":
        # {"a1": 270}, clockwise degrees): the renderer transposes, FCP rotates the original
        rot = int(project.get("aroll_rotate", {}).get(part, 0)) % 360
        if rot:
            assert rot in (90, 270), "aroll_rotate must be 90 or 270"
            tl.assets[f"aroll:{part}"].update(rotate=rot, media_w=H, media_h=W)

    def framing_at(r):
        for a, b, f in framing:
            if a <= r < b:
                return f
        return WIDE

    gain = project.get("voice_gain_db", 0.0)
    for r0, part, i, o in rec:
        pts = sorted({r0, r0 + (o - i)} | {a for a, _, _ in framing if r0 < a < r0 + (o - i)}
                     | {b for _, b, _ in framing if r0 < b < r0 + (o - i)})
        for a, b in zip(pts, pts[1:]):
            s, p = framing_at(a)
            tl.spine.append(Clip(asset=f"aroll:{part}", src=i + (a - r0), dur=b - a, scale=s, pos=p,
                                 volume_db=gain, name="A-roll"))
    # merge spine neighbours that are contiguous in source with identical framing
    sp = []
    for c in tl.spine:
        if sp and sp[-1].asset == c.asset and sp[-1].src + sp[-1].dur == c.src \
                and (sp[-1].scale, sp[-1].pos) == (c.scale, c.pos):
            sp[-1].dur += c.dur
        else:
            sp.append(c)
    tl.spine = sp
    tl.spine[-1].fade_out = s2f(0.5)
    tl.layout()

    # ---- 4. full-screen graphics and b-roll (lane 1)
    gsrc = pdir / "gfx_src"
    footage = getattr(mod, "BROLL", {})
    for a, b, k in shots:
        if k.startswith("G:"):
            name, _, at = k[2:].partition("@")
            if not (gsrc / name / "index.html").exists():
                warns.append(f"missing graphic {name}")
                continue
            frames = gfx_duration_frames(gsrc / name, rate)
            tl.assets[f"gfx:{name}"] = {"kind": "gfx", "name": name, "frames": frames, "alpha": False}
            src = s2f(float(at)) if at else 0          # resume a graphic after a cut to the host
            dur = b - a
            if src + dur > frames:
                warns.append(f"graphic {name} slot {src}+{dur} frames > media {frames}; clamped")
                dur = max(1, frames - src)
            tl.connected.append(Clip(asset=f"gfx:{name}", rec=a, dur=dur, src=src, lane=LANE_FULL, audio=False,
                                     name=name))
        elif k.startswith("B:"):
            bid, _, at = k[2:].partition("@")
            if bid not in footage:
                warns.append(f"unknown b-roll {bid}")
                continue
            spec = dict(footage[bid])
            if at:
                spec["in"] = float(at)
            if "sync" in spec:                         # a second angle: follow the A-roll's cuts
                sync = spec["sync"]
                ranges = []
                for r0, p, i, o in rec:
                    lo, hi = max(a, r0), min(b, r0 + (o - i))
                    if lo >= hi:
                        continue
                    if p != sync.get("part", "a1"):
                        warns.append(f"b-roll {bid} at {f2s(a):.2f}s spans A-roll part {p}, not synced to it")
                    ranges.append((f2s(i + (lo - r0)) + sync["offset"], hi - lo))
                key, asset, src, w = broll.synced_asset_for(vdir, bid, spec, ranges, rate)
            else:
                key, asset, src, w = broll.asset_for(vdir, bid, spec, b - a, rate)
            warns += w
            tl.assets[key] = asset
            tl.connected.append(Clip(asset=key, rec=a, dur=b - a, src=src, lane=LANE_FULL, audio=False, name=bid,
                                     scale=spec.get("scale", 1.0), pos=tuple(spec.get("pos", (0.0, 0.0)))))

    # ---- 5. overlay graphics (lane 2) and keyword pop-ups (lane 3)
    for e in getattr(mod, "OVL", []):
        part, (t0, t1, name) = anchor(e)
        if not (gsrc / name / "index.html").exists():
            warns.append(f"missing overlay graphic {name}")
            continue
        a, b = snap_to_cut(raw2rec(part, t0)), snap_to_cut(raw2rec(part, t1))
        frames = gfx_duration_frames(gsrc / name, rate)
        tl.assets[f"gfx:{name}"] = {"kind": "gfx", "name": name, "frames": frames, "alpha": True}
        if b - a > frames:
            warns.append(f"overlay {name} slot {b - a} frames > media {frames}; clamped")
        tl.connected.append(Clip(asset=f"gfx:{name}", rec=a, dur=min(b - a, frames), lane=LANE_OVL,
                                 audio=False, name=name))
    hits = {}
    hit_lane = project.get("hit_lane", LANE_HIT)
    for n, e in enumerate(getattr(mod, "HITS", []), 1):
        part, rest = anchor(e)
        t0, t1, text = rest[:3]
        variables = {"text": text, **(rest[3] if len(rest) > 3 else {})}
        key = f"hit_{n:02d}"
        hits[key] = variables if len(variables) > 1 else text
        a, b = snap_to_cut(raw2rec(part, t0)), snap_to_cut(raw2rec(part, t1))
        media = rate.gfx_frames(project.get("hit_media_seconds", 6.0))
        frames = s2f(project.get("hit_media_seconds", 6.0) * 1.001) if rate.ntsc else media
        tl.assets[f"gfx:{key}"] = {"kind": "gfx", "name": key, "frames": media,
                                   "alpha": True, "hit": text}
        # project "hit_pos": [x, y] FCP position (% of frame height, +y up) to lift pop-ups
        # clear of a host whose head sits higher than the template's zone; default (0, 0)
        tl.connected.append(Clip(asset=f"gfx:{key}", rec=a, dur=min(b - a, frames), lane=hit_lane, audio=False, name=text,
                                 pos=tuple(project.get("hit_pos", (0.0, 0.0)))))
    if write:
        (pdir / "hits.json").write_text(json.dumps(hits, ensure_ascii=False, indent=1), encoding="utf-8")

    # ---- 6. end fade (top lane) over the held quiet
    fade_frames = s2f(0.5)
    tl.assets["gfx:end_fade"] = {"kind": "gfx", "name": "end_fade", "frames": rate.gfx_frames(2.0), "alpha": True}
    tl.connected.append(Clip(asset="gfx:end_fade", rec=total - fade_frames, dur=fade_frames,
                             lane=project.get("end_lane", LANE_END), audio=False, name="Fade to black"))

    # ---- 7. SFX (lane -1): whoosh into full-screen graphics, pop on pop-ups
    manifest = json.loads((SFX_DIR / "manifest.json").read_text(encoding="utf-8"))
    whooshes = sorted(k for k in manifest if k.startswith("whoosh"))
    pops = sorted(k for k in manifest if k.startswith("pop"))
    whoosh_db = project.get("sfx_whoosh_db", -12.0)
    # "all": every graphic (quieter between graphics); "chapters": graphics named ch_* get the
    # full level, other graphics after the host get sfx_whoosh_minor_db (None = no whoosh)
    mode = project.get("whoosh_on", "all")
    minor_db = project.get("sfx_whoosh_minor_db")
    prev_kind = None
    wn = 0
    for a, b, k in shots:
        level = None
        if k.startswith("G:") and prev_kind is not None:
            after_host = not cover(prev_kind)
            if mode == "all":
                level = whoosh_db if after_host else whoosh_db - 4
            elif k.startswith("G:ch_"):
                level = whoosh_db
            elif after_host and minor_db is not None:
                level = minor_db
        if level is not None:
            add_sfx(tl, manifest, whooshes[wn % len(whooshes)], a, level)
            wn += 1
        prev_kind = k
    for n, c in enumerate([c for c in tl.connected if c.lane == hit_lane and c.asset.startswith("gfx:hit_")]):
        add_sfx(tl, manifest, pops[n % len(pops)], c.rec, project.get("sfx_pop_db", -14.0))

    for e in getattr(mod, "SFX", []):
        part, (t0, name, db) = anchor(e)
        add_sfx(tl, manifest, name, raw2rec(part, t0), db)

    # ---- 8. lane collisions: an overlay card on top of a full-screen graphic, or two at once
    ovl = [c for c in tl.connected if c.lane == LANE_OVL and c.asset.startswith("gfx:")
           and not c.asset.startswith("gfx:hit_")]
    full = [c for c in tl.connected if c.lane == LANE_FULL and c.asset.startswith("gfx:")]
    for c in ovl:
        for g in full:
            if c.rec < g.rec + g.dur and g.rec < c.rec + c.dur:
                warns.append(f"overlay {c.name} overlaps the full-screen graphic {g.asset.split(':', 1)[1]} "
                             f"at {f2s(c.rec):.2f}s")
    for i, c in enumerate(ovl):
        for d in ovl[i + 1:]:
            if c.rec < d.rec + d.dur and d.rec < c.rec + c.dur:
                warns.append(f"overlays {c.name} and {d.name} overlap at {f2s(max(c.rec, d.rec)):.2f}s")

    seg_meta = [[f2s(i), f2s(o)] for _, _, i, o in rec]
    if len(parts) > 1:
        seg_meta = [[p, f2s(i), f2s(o)] for _, p, i, o in rec]
    tl.meta = {"main": vdir.name, "segments": seg_meta, "warnings": warns}
    if write:
        bdir = pdir / "build"
        bdir.mkdir(exist_ok=True)
        tl.save(bdir / "timeline.json")
    return tl, warns


def add_sfx(tl, manifest, name, at_frame, volume_db):
    m = manifest[name]
    key = f"sfx:{name}"
    rate = tl.rate
    frames = m["samples"] // rate.spf                # whole frames inside the file
    tl.assets[key] = {"kind": "sfx", "file": rel(SFX_DIR / f"{name}.wav", tl.base), "samples": m["samples"], "frames": frames}
    peak = rate.s2f(m["peak"])
    rec = max(0, at_frame - peak)
    tl.connected.append(Clip(asset=key, rec=rec, dur=min(frames, tl.duration - rec), lane=-1, video=False,
                             volume_db=volume_db, name=name))
