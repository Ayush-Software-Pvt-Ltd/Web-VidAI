"""Final Cut Pro round trip: Timeline -> FCPXML 1.14, and FCPXML (as exported by FCP) -> Timeline.

Writer layout (project size and frame rate from the timeline):
  primary storyline   A-roll clips of every part (punch-ins as Transform, voice gain as Volume)
  lane 1              full-screen animations and b-roll (conformed ProRes clips with handles)
  lane 2..            overlays, keyword hits / pop-ups, fade to black (see plan.py)
  lane -1             SFX
Graphics are referenced at half size (FCP fits them to the frame); the final render
swaps in the 4K renders by name.  B-roll clips are the same files in FCP and the render.

Reader: walks the exported sequence (primary storyline, connected clips, secondary
storylines, gaps), maps media back to our assets by file name, and keeps transforms,
volume, fades and enabled state.  Anything it cannot render is reported, never dropped
silently.
"""
import urllib.parse
import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path

from .model import DEFAULT_FPS, Clip, Rate, Timeline


def parse_t(s):
    if s is None:
        return Fraction(0)
    s = s.strip().rstrip("s")
    return Fraction(s) if "/" in s else Fraction(s)


def _to_frames(s, warns=None, what="", rate=None):
    t = parse_t(s)
    f = t * (rate or Rate()).fps
    if f.denominator != 1 and warns is not None and abs(f - round(f)) > Fraction(1, 100):
        warns.append(f"{what}: time {s} is not on a frame boundary; rounded")
    return int(round(f))


def fmt_db(x):
    return f"{x:+.2f}dB".replace("+-", "-")


def fcp_rotation(asset):
    """FCP rotation (degrees, counter-clockwise positive) for an A-roll asset with a clockwise
    "rotate" (sideways camera file without a rotation flag); 0 for everything else."""
    if asset.get("kind") != "aroll" or not asset.get("rotate"):
        return 0
    return {90: -90, 270: 90}[asset["rotate"]]


# --------------------------------------------------------------------------- writer

def write(tl: Timeline, out_path, project_name, gfx_dir):
    tl.layout()
    ft = tl.rate.fcp_time
    gfx_dir = Path(gfx_dir)
    root = ET.Element("fcpxml", version="1.14")
    res = ET.SubElement(root, "resources")
    ET.SubElement(res, "format", id="r1", frameDuration=tl.rate.fcp_frame, width=str(tl.width),
                  height=str(tl.height), colorSpace="1-1-1 (Rec. 709)")
    ET.SubElement(res, "format", id="r2", frameDuration=tl.rate.fcp_frame, width=str(tl.width // 2),
                  height=str(tl.height // 2), colorSpace="1-1-1 (Rec. 709)")
    def aroll_fmt(a):
        return rot_fmt[(a["media_w"], a["media_h"])] if a.get("rotate") else "r1"

    ids = {}
    n = 3
    # sideways camera files keep their native size; the clip rotates them (conform "none")
    rot_fmt = {}
    for key, a in tl.assets.items():
        if a["kind"] == "aroll" and a.get("rotate"):
            size = (a["media_w"], a["media_h"])
            if size not in rot_fmt:
                rot_fmt[size] = f"r{n}"
                ET.SubElement(res, "format", id=f"r{n}", frameDuration=tl.rate.fcp_frame, width=str(size[0]),
                              height=str(size[1]), colorSpace="1-1-1 (Rec. 709)")
                n += 1
    for key, a in tl.assets.items():
        rid = f"r{n}"
        n += 1
        ids[key] = rid
        if a["kind"] == "aroll":
            path = tl.path(a["fcp_file"])
            el = ET.SubElement(res, "asset", id=rid, name=path.stem, start=ft(a.get("tc_start", 0)),
                               duration=ft(a["frames"]),
                               hasVideo="1", format=aroll_fmt(a), videoSources="1", hasAudio="1",
                               audioSources="1", audioChannels="2", audioRate="48000")
        elif a["kind"] == "gfx":
            path = gfx_dir / f"{a['name']}.mov"
            el = ET.SubElement(res, "asset", id=rid, name=a["name"], start="0s", duration=ft(a["frames"]),
                               hasVideo="1", format="r2", videoSources="1")
        elif a["kind"] == "broll":
            path = tl.path(a["file"])
            el = ET.SubElement(res, "asset", id=rid, name=path.stem, start="0s", duration=ft(a["frames"]),
                               hasVideo="1", format="r1", videoSources="1")
        else:
            path = tl.path(a["file"])
            el = ET.SubElement(res, "asset", id=rid, name=Path(a["file"]).stem, start="0s",
                               duration=f"{a['samples']}/48000s", hasAudio="1", audioSources="1",
                               audioChannels="2", audioRate="48000")
        if not path.exists():
            raise FileNotFoundError(path)
        ET.SubElement(el, "media-rep", kind="original-media", src=path.resolve().as_uri())

    lib = ET.SubElement(root, "library")
    ev = ET.SubElement(lib, "event", name=project_name)
    proj = ET.SubElement(ev, "project", name=project_name)
    seq = ET.SubElement(proj, "sequence", format="r1", duration=ft(tl.duration), tcStart="0s",
                        tcFormat="NDF", audioLayout="stereo", audioRate="48k")
    spine = ET.SubElement(seq, "spine")

    def tc(c):
        return tl.assets[c.asset].get("tc_start", 0)

    def clip_el(parent, c, offset_frames, lane=None):
        a = tl.assets[c.asset]
        attrs = {"ref": ids[c.asset]}
        if lane:
            attrs["lane"] = str(lane)
        # media times of camera files with a timecode start at it (asset "tc_start" frames)
        attrs.update(offset=ft(offset_frames), name=c.name or a.get("name", c.asset), start=ft(c.src + tc(c)),
                     duration=ft(c.dur))
        if a["kind"] == "aroll":
            attrs.update(format=aroll_fmt(a), tcFormat="NDF", audioRole="dialogue")
        elif a["kind"] == "gfx":
            attrs.update(format="r2", tcFormat="NDF")
        elif a["kind"] == "broll":
            attrs.update(format="r1", tcFormat="NDF")
        else:
            attrs.update(audioRole="effects")
        el = ET.SubElement(parent, "asset-clip", attrs)
        turn = fcp_rotation(a)
        if turn:
            ET.SubElement(el, "adjust-conform", type="none")
        if a["kind"] != "sfx" and (c.scale != 1.0 or tuple(c.pos) != (0.0, 0.0) or turn):
            t = {"position": f"{c.pos[0]:g} {c.pos[1]:g}", "scale": f"{c.scale:g} {c.scale:g}"}
            if turn:
                t["rotation"] = f"{turn:g}"
            ET.SubElement(el, "adjust-transform", t)
        if a["kind"] not in ("gfx", "broll") and (c.volume_db or c.fade_in or c.fade_out):
            vol = ET.SubElement(el, "adjust-volume", amount=fmt_db(c.volume_db))
            if c.fade_in or c.fade_out:
                p = ET.SubElement(vol, "param", name="amount")
                if c.fade_in:
                    ET.SubElement(p, "fadeIn", type="easeIn", duration=ft(c.fade_in))
                if c.fade_out:
                    ET.SubElement(p, "fadeOut", type="easeOut", duration=ft(c.fade_out))
        return el

    spine_els = []
    for c in tl.spine:
        spine_els.append((c, clip_el(spine, c, c.rec)))
    for c in sorted(tl.connected, key=lambda c: (c.rec, c.lane)):
        host = None
        for s, el in spine_els:
            if s.rec <= c.rec < s.end:
                host = (s, el)
                break
        if host is None:
            host = spine_els[-1]
        s, el = host
        clip_el(el, c, s.src + tc(s) + (c.rec - s.rec), lane=c.lane)

    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    Path(out_path).write_text('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n\n' + body + "\n",
                              encoding="utf-8")
    return out_path


# --------------------------------------------------------------------------- reader

def read(path, assets, warns, fps=DEFAULT_FPS, base=None):
    """Parse an FCP export into a Timeline that uses our asset keys.

    `assets` is the asset table of the timeline we exported (to map files back); `fps` is
    its frame rate, which the exported sequence must have."""
    path = Path(path)
    if path.is_dir():                                   # .fcpxmld bundle
        cands = sorted(path.glob("*.fcpxml"))
        if not cands:
            raise FileNotFoundError(f"no .fcpxml inside {path}")
        path = cands[0]
    root = ET.parse(path).getroot()
    by_file = {}
    for key, a in assets.items():
        if a["kind"] == "aroll":
            by_file[Path(a["fcp_file"]).name] = key
            by_file[Path(a["file"]).name] = key
        elif a["kind"] == "gfx":
            by_file[f"{a['name']}.mov"] = key
        elif a["kind"] == "broll":
            by_file[Path(a["file"]).name] = key
        else:
            by_file[Path(a["file"]).name] = key
    rid2key = {}
    formats = {f.get("id"): f for f in root.iter("format")}
    for el in root.find("resources"):
        if el.tag != "asset":
            continue
        rep = el.find("media-rep")
        src = urllib.parse.unquote(urllib.parse.urlparse(rep.get("src")).path) if rep is not None else ""
        key = by_file.get(Path(src).name)
        if key is None:
            warns.append(f"unknown media {src!r} ({el.get('name')}); clips using it are skipped")
        rid2key[el.get("id")] = key
    seqs = list(root.iter("sequence"))
    if not seqs:
        raise ValueError("no sequence in the FCPXML")
    if len(seqs) > 1:
        warns.append(f"{len(seqs)} sequences found; using the first project's")
    seq = seqs[0]
    fmt = formats.get(seq.get("format"))
    rate = Rate(fps)
    tl = Timeline(width=int(fmt.get("width")), height=int(fmt.get("height")), fps=rate.ff, assets=dict(assets),
                  base=base)
    if parse_t(fmt.get("frameDuration")) != 1 / rate.fps:
        warns.append(f"sequence frame duration {fmt.get('frameDuration')} is not {rate.fcp_frame}")
    to_frames = lambda s, w=None, what="": _to_frames(s, w, what, rate)  # noqa: E731

    def adjust(el, c):
        t = el.find("adjust-transform")
        if t is not None and t.get("enabled", "1") == "1":
            pos = [float(v) for v in t.get("position", "0 0").split()]
            sc = [float(v) for v in t.get("scale", "1 1").split()]
            if abs(sc[0] - sc[1]) > 1e-4:
                warns.append(f"{c.name}: non-uniform scale {sc}; using {sc[0]}")
            if float(t.get("rotation", "0")) != fcp_rotation(assets.get(c.asset) or {}):
                warns.append(f"{c.name}: rotation is not supported; ignored")
            if t.get("anchor", "0 0") not in ("0 0", "0.0 0.0"):
                warns.append(f"{c.name}: transform anchor is not supported; ignored")
            if t.find("param") is not None:
                warns.append(f"{c.name}: keyframed transform is not supported; using the static values")
            c.scale, c.pos = sc[0], (pos[0], pos[1])
        v = el.find("adjust-volume")
        if v is not None:
            amt = v.get("amount", "0dB")
            c.volume_db = float(amt.replace("dB", "")) if amt.endswith("dB") else 0.0
            for p in v.findall("param"):
                if p.find("keyframeAnimation") is not None:
                    warns.append(f"{c.name}: volume keyframes are not supported; using the base level")
                fi, fo = p.find("fadeIn"), p.find("fadeOut")
                if fi is not None:
                    c.fade_in = to_frames(fi.get("duration"), warns, c.name)
                if fo is not None:
                    c.fade_out = to_frames(fo.get("duration"), warns, c.name)
        for tag in ("adjust-crop", "adjust-blend", "adjust-corners", "filter-video", "filter-audio", "timeMap",
                    "conform-rate"):
            e = el.find(tag)
            if e is not None and e.get("enabled", "1") == "1" and tag != "conform-rate":
                warns.append(f"{c.name}: {tag} is not supported by the renderer; ignored")
        if el.find("adjust-speed") is not None or el.find("timeMap") is not None:
            warns.append(f"{c.name}: speed changes are not supported; played at 100%")

    def media_of(el):
        """(asset key, src frames, video?, audio?) for asset-clip / clip / video / audio elements."""
        tag = el.tag
        if tag in ("asset-clip", "video", "audio"):
            key = rid2key.get(el.get("ref"))
            se = el.get("srcEnable", "all")
            v = tag != "audio" and se in ("all", "video")
            a = tag != "video" and se in ("all", "audio")
            return key, to_frames(el.get("start"), warns, el.get("name", "")), v, a
        if tag == "clip":
            inner = [x for x in el if x.tag in ("asset-clip", "video", "audio") and x.get("lane") is None]
            if not inner:
                warns.append(f"clip {el.get('name')!r} has no media; treated as a gap")
                return None, 0, False, False
            m = inner[0]
            key, istart, _, _ = media_of(m)
            # clip.start is in the clip's own timeline; the media sits at m.offset in it
            src = istart + to_frames(el.get("start")) - to_frames(m.get("offset"))
            has_v = any(x.tag in ("video", "asset-clip") for x in inner)
            has_a = any(x.tag in ("audio", "asset-clip") for x in inner) or el.find("audio") is not None
            return key, src, has_v, has_a
        return None, 0, False, False

    def item_clip(el, rec, lane):
        key, src, v, a = media_of(el)
        if key is not None:
            src -= assets[key].get("tc_start", 0)        # camera timecode -> frames from the file start
        dur = to_frames(el.get("duration"), warns, el.get("name", ""))
        c = Clip(asset=key or "", src=src, dur=dur, rec=rec, lane=lane, name=el.get("name", ""),
                 video=v, audio=a)
        if el.get("enabled", "1") == "0":
            c.video = c.audio = False
        if key is None:
            c.asset = ""
            c.video = c.audio = False
        else:                                   # a clip can only use what its media has
            kind = assets[key]["kind"]
            c.video = c.video and kind != "sfx"
            c.audio = c.audio and kind not in ("gfx", "broll")
        adjust(el, c)
        return c

    def walk(spine_el, rec0, lane, out_spine):
        t = rec0
        for el in spine_el:
            if el.tag == "transition":
                warns.append(f"transition {el.get('name')!r} at {rate.f2s(t):.2f}s is not supported; hard cut used")
                continue
            if el.tag not in ("asset-clip", "clip", "gap", "video", "audio", "title", "ref-clip", "sync-clip",
                              "mc-clip", "audition"):
                continue
            dur = to_frames(el.get("duration"), warns, el.get("name", ""))
            if el.tag == "gap":
                c = Clip(asset="", dur=dur, rec=t, lane=lane, video=False, audio=False, name="gap")
            elif el.tag in ("asset-clip", "clip", "video", "audio"):
                c = item_clip(el, t, lane)
            else:
                warns.append(f"{el.tag} {el.get('name')!r} is not supported; shown as black")
                c = Clip(asset="", dur=dur, rec=t, lane=lane, video=False, audio=False, name=el.tag)
            if out_spine is not None:
                out_spine.append(c)
            else:
                tl.connected.append(c)
            # anchored items: offsets are in this element's own timeline (which starts at its start)
            start = to_frames(el.get("start"))
            for ch in el:
                ln = ch.get("lane")
                if ln is None:
                    continue
                crec = t + to_frames(ch.get("offset"), warns, ch.get("name", "")) - start
                if ch.tag == "spine":
                    walk(ch, crec, lane + int(ln), None)
                elif ch.tag in ("asset-clip", "clip", "video", "audio"):
                    tl.connected.append(item_clip(ch, crec, lane + int(ln)))
                elif ch.tag in ("title", "ref-clip", "sync-clip", "mc-clip", "audition"):
                    warns.append(f"connected {ch.tag} {ch.get('name')!r} is not supported; ignored")
            t += dur

    walk(seq.find("spine"), 0, 0, tl.spine)
    tl.layout()
    return tl
