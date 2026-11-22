"""Premiere Pro review export: Timeline -> Final Cut Pro 7 XML (xmeml version 4).

Premiere Pro imports FCP7 XML (it does NOT import FCPXML), so this is the review file on
Windows and Linux.  The mapping is the same timeline model the FCPXML writer uses:

  video track 1        A-roll clips of every part (punch-ins as Basic Motion scale/center)
  video track 2..      lane 1 full-screen graphics and b-roll, then lane 2 overlays, lane 3 hits
  audio track 1        A-roll audio (one clipitem per spine clip, volume as Audio Levels dB)
  audio track 2        SFX

Graphics are rendered at half size for FCP (1080 wide for a 2160 project); Premiere does not
spatial-conform media to the sequence, so their Basic Motion scale is doubled to fill the
frame.  B-roll mezzanines are already at project size.

A camera file gets two <file> entries (video-only and audio-only) so Premiere never links an
unexpected second copy of the sound.
"""
import re
import xml.etree.ElementTree as ET
from pathlib import Path, PureWindowsPath
from urllib.parse import quote, unquote, urlparse


# FCP7 <rate>: timebase + NTSC flag
RATES = {
    "24000/1001": (24, True), "24": (24, False), "25": (25, False),
    "30000/1001": (30, True), "30": (30, False), "50": (50, False),
    "60000/1001": (60, True), "60": (60, False),
}


def _tb(rate):
    return RATES.get(rate.ff, (round(float(rate.fps)), False))


def rate_el(parent, rate):
    tb, ntsc = _tb(rate)
    r = ET.SubElement(parent, "rate")
    ET.SubElement(r, "timebase").text = str(tb)
    ET.SubElement(r, "ntsc").text = "TRUE" if ntsc else "FALSE"
    return r


def sample_el(parent, width, height, rate):
    sc = ET.SubElement(parent, "samplecharacteristics")
    rate_el(sc, rate)
    ET.SubElement(sc, "width").text = str(width)
    ET.SubElement(sc, "height").text = str(height)
    ET.SubElement(sc, "anamorphic").text = "FALSE"
    ET.SubElement(sc, "pixelaspectratio").text = "square"
    ET.SubElement(sc, "fielddominance").text = "none"


def pathurl(path):
    r"""The <pathurl> of a media file, written the way Premiere Pro itself writes it.

    Windows: file://localhost/C%3a/Users/... (a network path \\server\share\... becomes
    file://server/share/...).  Premiere on Windows reads file:///C:/... (what Path.as_uri()
    gives) as a network path and looks for \\\C:\..., so it would find no media.
    macOS and Linux: file://localhost/Users/...
    """
    return url_of(Path(path).resolve())


def url_of(p):
    """`pathurl` of an absolute PurePath; Windows paths are written the Windows way on any OS."""
    if isinstance(p, PureWindowsPath):
        if p.drive.startswith("\\\\"):
            host, _, share = p.drive[2:].partition("\\")
            return f"file://{host}/" + quote("/".join([share, *p.parts[1:]]))
        return f"file://localhost/{p.drive[0]}%3a/" + quote("/".join(p.parts[1:]))
    return "file://localhost" + quote(p.as_posix())


def path_of(url):
    """The local path a <pathurl> points at (inverse of `pathurl`); reads every common form."""
    u = urlparse(url)
    p = unquote(u.path)
    if re.match(r"^/[A-Za-z]:", p):
        return Path(p[1:])
    if u.netloc and u.netloc != "localhost":
        return Path(f"//{u.netloc}{p}")
    return Path(p)


def file_body(parent, fid, path, rate, frames, kind, width, height):
    f = ET.SubElement(parent, "file", id=fid)
    ET.SubElement(f, "name").text = path.stem
    ET.SubElement(f, "pathurl").text = pathurl(path)
    rate_el(f, rate)
    ET.SubElement(f, "duration").text = str(max(1, int(frames)))
    media = ET.SubElement(f, "media")
    if kind == "video":
        sample_el(ET.SubElement(media, "video"), width, height, rate)
    else:
        a = ET.SubElement(media, "audio")
        sc = ET.SubElement(a, "samplecharacteristics")
        ET.SubElement(sc, "depth").text = "16"
        ET.SubElement(sc, "samplerate").text = "48000"
        ET.SubElement(a, "channelcount").text = "2"
    return f


def motion_el(clip, scale_percent, center_px):
    if abs(scale_percent - 100) < 0.01 and abs(center_px[0]) < 0.5 and abs(center_px[1]) < 0.5:
        return
    e = ET.SubElement(ET.SubElement(clip, "filter"), "effect")
    ET.SubElement(e, "name").text = "Basic Motion"
    ET.SubElement(e, "effectid").text = "basic"
    ET.SubElement(e, "effectcategory").text = "motion"
    ET.SubElement(e, "effecttype").text = "motion"
    ET.SubElement(e, "mediatype").text = "video"
    p = ET.SubElement(e, "parameter")
    ET.SubElement(p, "parameterid").text = "scale"
    ET.SubElement(p, "name").text = "Scale"
    ET.SubElement(p, "value").text = f"{scale_percent:g}"
    p = ET.SubElement(e, "parameter")
    ET.SubElement(p, "parameterid").text = "center"
    ET.SubElement(p, "name").text = "Center"
    v = ET.SubElement(p, "value")
    ET.SubElement(v, "horiz").text = f"{center_px[0]:g}"
    ET.SubElement(v, "vert").text = f"{center_px[1]:g}"


def level_el(clip, db):
    e = ET.SubElement(ET.SubElement(clip, "filter"), "effect")
    ET.SubElement(e, "name").text = "Audio Levels"
    ET.SubElement(e, "effectid").text = "audiolevels"
    ET.SubElement(e, "effectcategory").text = "audiolevels"
    ET.SubElement(e, "effecttype").text = "audio"
    ET.SubElement(e, "mediatype").text = "audio"
    p = ET.SubElement(e, "parameter")
    ET.SubElement(p, "parameterid").text = "level"
    ET.SubElement(p, "name").text = "Level"
    ET.SubElement(p, "value").text = f"{db:.2f}"


def fades_el(clip, fade_in, fade_out):
    """Audio Fades effect: values are frames, as Final Cut 7 wrote them."""
    e = ET.SubElement(ET.SubElement(clip, "filter"), "effect")
    ET.SubElement(e, "name").text = "Audio Fades"
    ET.SubElement(e, "effectid").text = "audiofade"
    ET.SubElement(e, "effectcategory").text = "audio"
    ET.SubElement(e, "effecttype").text = "audio"
    ET.SubElement(e, "mediatype").text = "audio"
    for pid, name, frames in (("fadein", "Fade In", fade_in), ("fadeout", "Fade Out", fade_out)):
        p = ET.SubElement(e, "parameter")
        ET.SubElement(p, "parameterid").text = pid
        ET.SubElement(p, "name").text = name
        ET.SubElement(p, "value").text = str(int(frames))


class Writer:
    def __init__(self, tl, gfx_dir):
        self.tl = tl
        self.rate = tl.rate
        self.W, self.H = tl.width, tl.height
        self.gfx_dir = Path(gfx_dir)
        self.files = {}            # (key, kind) -> (fid, path, frames, w, h)
        self.declared = set()
        self.nf = 0
        self.nclip = 0

    def file_for(self, key, kind):
        if (key, kind) in self.files:
            return self.files[(key, kind)]
        a = self.tl.assets[key]
        if a["kind"] == "aroll":
            path, frames, w, h = self.tl.path(a["fcp_file"]), a["frames"], a.get("w", self.W), a.get("h", self.H)
        elif a["kind"] == "gfx":
            path, frames, w, h = self.gfx_dir / f"{a['name']}.mov", a["frames"], self.W // 2, self.H // 2
        elif a["kind"] == "broll":
            path, frames, w, h = self.tl.path(a["file"]), a["frames"], self.W, self.H
        else:
            path = self.tl.path(a["file"])
            frames = max(1, round(a["samples"] * float(self.rate.fps) / 48000))
            w = h = 0
        if not path.exists():
            raise FileNotFoundError(path)
        self.nf += 1
        self.files[(key, kind)] = (f"file-{self.nf}", path, frames, w, h)
        return self.files[(key, kind)]

    def clip(self, track, c, kind, media_frames=None, motion=None, audio=None, track_index=None):
        a = self.tl.assets[c.asset]
        fid, path, frames, w, h = self.file_for(c.asset, kind)
        self.nclip += 1
        cl = ET.SubElement(track, "clipitem", id=f"clipitem-{self.nclip}")
        ET.SubElement(cl, "name").text = c.name or a.get("name", c.asset)
        ET.SubElement(cl, "duration").text = str(max(1, int(media_frames or frames)))
        rate_el(cl, self.rate)
        ET.SubElement(cl, "start").text = str(int(c.rec))
        ET.SubElement(cl, "end").text = str(int(c.end))
        ET.SubElement(cl, "in").text = str(int(c.src))
        ET.SubElement(cl, "out").text = str(int(c.src + c.dur))
        if fid in self.declared:
            ET.SubElement(cl, "file", id=fid)
        else:
            file_body(cl, fid, path, self.rate, frames, kind, w, h)
            self.declared.add(fid)
        if motion:
            motion_el(cl, *motion)
        if audio is not None:
            level_el(cl, audio)
            if c.fade_in or c.fade_out:
                fades_el(cl, c.fade_in, c.fade_out)
        if track_index is not None:
            st = ET.SubElement(cl, "sourcetrack")
            ET.SubElement(st, "mediatype").text = "audio"
            ET.SubElement(st, "trackindex").text = str(track_index)
        return cl

    def run(self, project_name, out_path):
        tl, rate, H = self.tl, self.rate, self.H
        root = ET.Element("xmeml", version="4")
        seq = ET.SubElement(root, "sequence", id="sequence-1")
        ET.SubElement(seq, "name").text = project_name
        ET.SubElement(seq, "duration").text = str(tl.duration)
        rate_el(seq, rate)
        tc = ET.SubElement(seq, "timecode")
        rate_el(tc, rate)
        ET.SubElement(tc, "string").text = "00:00:00:00"
        ET.SubElement(tc, "frame").text = "0"
        ET.SubElement(tc, "displayformat").text = "NDF"

        media = ET.SubElement(seq, "media")
        video = ET.SubElement(media, "video")
        sample_el(ET.SubElement(video, "format"), self.W, H, rate)
        audio = ET.SubElement(media, "audio")
        asc = ET.SubElement(ET.SubElement(audio, "format"), "samplecharacteristics")
        ET.SubElement(asc, "depth").text = "16"
        ET.SubElement(asc, "samplerate").text = "48000"

        lanes = {}
        for c in tl.spine:
            lanes.setdefault(0, []).append(c)
        for c in tl.connected:
            if c.video and c.lane > 0:
                lanes.setdefault(c.lane, []).append(c)
        for lane in sorted(lanes):
            tr = ET.SubElement(video, "track")
            for c in sorted(lanes[lane], key=lambda x: x.rec):
                a = tl.assets[c.asset]
                # FCP pos is % of the frame height with +y up; FCP7 center is pixels, +y up
                center = (c.pos[0] * H / 100.0, c.pos[1] * H / 100.0)
                factor = 200.0 if a["kind"] == "gfx" else 100.0
                self.clip(tr, c, "video", motion=(c.scale * factor, center))
            ET.SubElement(tr, "enabled").text = "TRUE"
            ET.SubElement(tr, "locked").text = "FALSE"

        atr = ET.SubElement(audio, "track")
        for c in tl.spine:
            if c.audio and c.asset:
                self.clip(atr, c, "audio", audio=c.volume_db, track_index=1)
        ET.SubElement(atr, "enabled").text = "TRUE"
        ET.SubElement(atr, "locked").text = "FALSE"

        sfx = [c for c in tl.connected if c.audio and c.lane < 0]
        if sfx:
            st = ET.SubElement(audio, "track")
            for c in sorted(sfx, key=lambda x: x.rec):
                a = tl.assets[c.asset]
                frames = max(1, round(a["samples"] * float(rate.fps) / 48000))
                self.clip(st, c, "audio", media_frames=frames, audio=c.volume_db, track_index=1)
            ET.SubElement(st, "enabled").text = "TRUE"
            ET.SubElement(st, "locked").text = "FALSE"

        ET.indent(root, space="  ")
        body = ET.tostring(root, encoding="unicode")
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body + "\n", encoding="utf-8")
        return out_path


def write(tl, out_path, project_name, gfx_dir):
    tl.layout()
    return Writer(tl, gfx_dir).run(project_name, out_path)


def _fps_from_el(el):
    r = el.find("rate")
    if r is None:
        return None
    tb = int(r.findtext("timebase", "24"))
    ntsc = (r.findtext("ntsc", "FALSE").upper() == "TRUE")
    if ntsc:
        return {24: "24000/1001", 30: "30000/1001", 60: "60000/1001"}.get(tb, f"{tb * 1000 // 1001}/1000")
    return str(tb)


def read(path, assets, warns, fps=None, base=None):
    """Parse a Premiere/FCP7 XML back into a Timeline that uses our asset keys.

    Video track 1 is the primary storyline; later video tracks are connected lanes 1, 2, ...
    The first audio track only turns the matching spine clips' sound on (with its level);
    later audio tracks become lane -1 SFX clips.
    """
    from .model import Clip, Timeline

    path = Path(path)
    root = ET.parse(path).getroot()
    seq = root.find("sequence") if root.tag == "xmeml" else next(root.iter("sequence"))
    fmt = seq.find("media/video/format/samplecharacteristics")
    W = int(fmt.findtext("width", "2160"))
    H = int(fmt.findtext("height", "3840"))
    rate = _fps_from_el(fmt) or fps or "24000/1001"
    tl = Timeline(width=W, height=H, fps=rate, assets=dict(assets), base=base)

    by_name = {}
    for key, a in assets.items():
        if a["kind"] == "aroll":
            by_name[Path(a["fcp_file"]).name] = key
            by_name[Path(a["file"]).name] = key
        elif a["kind"] == "gfx":
            by_name[f"{a['name']}.mov"] = key
        else:
            by_name[Path(a["file"]).name] = key
    ids = {}
    for f in root.iter("file"):
        if f.get("id") and f.find("pathurl") is not None:
            ids[f.get("id")] = path_of(f.find("pathurl").text).name

    def key_of(cl):
        f = cl.find("file")
        if f is None:
            return None
        return by_name.get(ids.get(f.get("id")))

    def motion(cl):
        scale, pos = 1.0, (0.0, 0.0)
        for e in cl.iter("effect"):
            if e.findtext("effectid") != "basic":
                continue
            for p in e.findall("parameter"):
                pid = p.findtext("parameterid")
                if pid == "scale":
                    scale = float(p.findtext("value", "100")) / 100.0
                elif pid == "center":
                    v = p.find("value")
                    pos = (float(v.findtext("horiz", "0")) / H * 100.0,
                           float(v.findtext("vert", "0")) / H * 100.0)
        return scale, pos

    def level(cl):
        for e in cl.iter("effect"):
            if e.findtext("effectid") != "audiolevels":
                continue
            for p in e.findall("parameter"):
                if p.findtext("parameterid") == "level":
                    try:
                        return float(p.findtext("value", "0"))
                    except ValueError:
                        return 0.0
        return 0.0

    def clip_of(cl, lane, video):
        key = key_of(cl)
        if key is None:
            warns.append(f"{cl.get('name')!r}: unknown media; clip skipped")
            return None
        start, end = int(cl.findtext("start", "0")), int(cl.findtext("end", "0"))
        src = int(cl.findtext("in", "0"))
        c = Clip(asset=key, src=src, dur=max(0, end - start), rec=start, lane=lane,
                 name=cl.findtext("name", ""), video=video, audio=not video)
        if video:
            c.scale, c.pos = motion(cl)
            if assets[key]["kind"] == "gfx":
                c.scale /= 2.0                    # the writer doubled it for Premiere
        else:
            c.volume_db = level(cl)
            for e in cl.iter("effect"):
                if e.findtext("effectid") != "audiofade":
                    continue
                for p in e.findall("parameter"):
                    pid = p.findtext("parameterid")
                    if pid == "fadein":
                        c.fade_in = int(float(p.findtext("value", "0")))
                    elif pid == "fadeout":
                        c.fade_out = int(float(p.findtext("value", "0")))
        return c

    video = seq.find("media/video")
    spine, lanes = [], {}
    for ti, tr in enumerate(video.findall("track")):
        for cl in tr.findall("clipitem"):
            c = clip_of(cl, ti, True)
            if c is None:
                continue
            if ti == 0:
                spine.append(c)
            else:
                lanes.setdefault(ti, []).append(c)
    spine.sort(key=lambda c: c.rec)
    laid, t = [], 0
    for c in spine:
        if c.rec > t:
            laid.append(Clip(asset="", dur=c.rec - t, rec=t, video=False, audio=False, name="gap"))
        c.rec = t
        laid.append(c)
        t += c.dur
    tl.spine = laid
    for lane, cs in lanes.items():
        for c in cs:
            # FCP7 tracks are compressed (an empty lane leaves no track), so recover our lane
            # numbers from what the clip is: hits, the end fade, everything else.
            kind = assets[c.asset]["kind"]
            if kind == "gfx":
                name = assets[c.asset].get("name", "")
                if not assets[c.asset].get("alpha", True):
                    c.lane = 1                       # opaque full-screen card
                else:
                    c.lane = 4 if name == "end_fade" else 3 if name.startswith("hit_") else 2
            else:
                c.lane = 1
            tl.connected.append(c)

    audio = seq.find("media/audio")
    if audio is not None:
        for ai, tr in enumerate(audio.findall("track")):
            for cl in tr.findall("clipitem"):
                c = clip_of(cl, -1 if ai else 0, False)
                if c is None:
                    continue
                if ai == 0:
                    for s in tl.spine:
                        if s.asset == c.asset and s.rec == c.rec:
                            s.audio = True
                            s.volume_db = c.volume_db
                            s.fade_in, s.fade_out = c.fade_in, c.fade_out
                            break
                else:
                    tl.connected.append(c)
    tl.layout()
    return tl


def check(path):
    """Read the file back: every clipitem must point at a file that exists."""
    root = ET.parse(path).getroot()
    problems, ids = [], {}
    for f in root.iter("file"):
        if f.get("id") and f.find("pathurl") is not None:
            ids[f.get("id")] = f
    for cl in root.iter("clipitem"):
        f = cl.find("file")
        if f is None or f.get("id") not in ids:
            problems.append(f"clipitem {cl.get('id')} has no resolvable file")
            continue
        p = path_of(ids[f.get("id")].find("pathurl").text)
        if not p.exists():
            problems.append(f"missing media {p}")
    return problems
