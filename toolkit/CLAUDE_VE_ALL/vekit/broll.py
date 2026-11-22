"""B-roll footage as conformed clips ("mezzanines") that FCP and the renderer share.

Every use of a b-roll clip in the timeline becomes one ProRes file at exactly the timeline
frame rate in <MAIN>/CLAUDE_VE/broll/mezz/:
  - every source frame is used once (30 fps phone footage plays at 80 %, never drops frames);
    footage much slower than the timeline (23.976 in a 59.94 timeline) would fast-forward that
    way, so it plays in real time instead, frames picked by timestamp (3:2 repeats)
  - one second of handles on each side, so the creator can slip or extend the shot in FCP
  - optional reframing: "rotate": 180 (footage shot upside down), "crop": [x0, y0, x1, y1]
    (fractions of the rotated frame, same aspect as the project, e.g. a 9:16 window out of
    16:9 footage for a vertical video)
  - optional motion baked in, so locked-off shots never look frozen:
      push   slow push-in (about 100 % -> 106 % over the slot)
      pull   the reverse
      left / right   lateral drift at 108 %
      none   untouched (camera moves already)
Synced b-roll (spec "sync": {"part": "a1", "offset": sec}) is a second angle recorded at the
same time as the A-roll, e.g. a screen recording: source time = A-roll raw time + offset.
Its slot follows the A-roll's jump cuts (one source range per kept piece), frames are
picked by timestamp (screen recordings are variable frame rate), and an optional layout
puts it on a background:
  "crop": [x0, y0, x1, y1]   part of the source (fractions), default all of it
  "box":  [x, y, w, h]       where it goes in the frame (fractions), aspect kept, centred in the box
  "radius": r                rounded corners, fraction of the frame height
  "bg": path                 background image in the video folder (shadows, bezel baked in)
  "pip": {"file": A-roll in the video folder, "offset": sec, "crop": [x0, y0, x1, y1],
          "box": [x, y, w, h]}
                             the host, lip-synced, in a circle on top: A-roll time = source time
                             - offset, crop of the A-roll (fractions) fitted into the box; the
                             ring and shadow belong in "bg"
  "codec": "hevc"            hardware HEVC (10-bit, ~50 Mbps) instead of ProRes; screen recordings
                             are low-detail, and 4K ProRes of long synced uses fills the disk
Decoding and encoding use the machine's hardware when ffmpeg offers it (vekit/resources.py).
"""
import hashlib
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction

from .model import DEFAULT_FPS, Rate
from . import resources, tools
from .paths import project_dir, rel, resolve, video_dir

HANDLE = 24                     # frames of handle on each side (source frames = output frames)
PUSH = 0.06                     # zoom gained over the slot for push / pull
DRIFT_ZOOM = 1.08
REALTIME_ABOVE = 1.3            # timeline fps / source fps above which footage plays in real time


def probe(src, cache):
    key = str(src)
    if key not in cache:
        out = subprocess.run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "stream=r_frame_rate,nb_frames,width,height:format=duration", "-of", "json", str(src)],
                             capture_output=True, text=True, encoding="utf-8", errors="replace", check=True).stdout
        d = json.loads(out)
        st = d["streams"][0]
        fps = Fraction(st["r_frame_rate"])
        n = int(st.get("nb_frames") or 0) or int(float(d["format"]["duration"]) * fps)
        cache[key] = {"fps": str(fps), "frames": n, "w": st["width"], "h": st["height"],
                      "dur": float(d["format"]["duration"])}
    return cache[key]


def _probe_cache(pdir):
    p = pdir / "broll" / "probe.json"
    return p, (json.loads(p.read_text(encoding="utf-8")) if p.exists() else {})


def _probe(pdir, src, need=()):
    pfile, cache = _probe_cache(pdir)
    n = len(cache)
    if any(k not in cache.get(str(src), {}) for k in need):
        cache.pop(str(src), None)                       # older cache entry without that field
        n = -1
    info = probe(src, cache)
    if len(cache) != n:
        pfile.parent.mkdir(parents=True, exist_ok=True)
        pfile.write_text(json.dumps(cache, indent=1), encoding="utf-8")
    return info


def asset_for(main, bid, spec, slot, rate=None):
    """Asset for one use of b-roll `bid` filling `slot` frames.
    Returns (asset key, asset dict, clip in-point inside the mezzanine, warnings)."""
    rate = rate or Rate()
    vdir = video_dir(main)
    pdir = project_dir(vdir)
    warns = []
    src = vdir / spec["file"]
    info = _probe(pdir, src)
    fps = Fraction(info["fps"])
    nb = info["frames"]
    realtime = rate.fps / fps > REALTIME_ABOVE
    if realtime:                                                  # count in timeline frames instead
        nb, fps = int(nb * rate.fps / fps), rate.fps
    lo = int(round(spec.get("lo", 0.0) * fps))                   # usable window of the clip
    hi = min(nb, int(round(spec["hi"] * fps))) if "hi" in spec else nb
    want = int(round(spec.get("in", 0.0) * fps))
    if slot > hi - lo:
        warns.append(f"b-roll {bid}: slot {slot} frames > usable {hi - lo} frames; the clip runs out")
    if want + slot > hi:
        shifted = max(lo, hi - slot)
        if shifted != want:
            warns.append(f"b-roll {bid}: in-point moved {float((want - shifted) / fps):.2f}s earlier to fit the slot")
        want = shifted
    want = max(lo, want)
    start = max(0, want - HANDLE)
    end = min(nb, want + slot + HANDLE)
    motion = spec.get("motion", "none")
    frames = end - start
    reframe = {k: spec[k] for k in ("rotate", "crop") if k in spec}
    name = f"{bid}_{start}_{frames}_{motion}"
    if reframe or realtime:
        name += "_" + hashlib.sha1(json.dumps([reframe, realtime], sort_keys=True).encode()).hexdigest()[:8]
    if "crop" in reframe:
        x0, y0, x1, y1 = reframe["crop"]
        sw, sh = (info["h"], info["w"]) if reframe.get("rotate") in (90, 270) else (info["w"], info["h"])
        aspect = (x1 - x0) * sw / ((y1 - y0) * sh)
        project = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
        want_aspect = project.get("width", 2160) / project.get("height", 3840)
        if abs(aspect / want_aspect - 1) > 0.01:
            warns.append(f"b-roll {bid}: crop aspect {aspect:.4f} differs from the project's {want_aspect:.4f}")
    mezz = pdir / "broll" / "mezz" / f"{name}.mov"
    asset = {"kind": "broll", "name": bid, "file": rel(mezz, vdir), "frames": frames, "alpha": False,
             "src_file": rel(src, vdir), "src_fps": info["fps"], "src_start": start, "motion": motion,
             "slot": slot, **reframe}
    if realtime:
        asset["realtime"] = True                                # src_start is in timeline frames
    if not rate.ntsc:
        asset["fps"] = rate.ff
    return f"broll:{name}", asset, want - start, warns


def synced_asset_for(main, bid, spec, ranges, rate):
    """Asset for one use of a synced b-roll.  `ranges` = [(source seconds, frames), ...], one per
    kept A-roll piece inside the slot, in record order.  Returns (key, asset, in-point 0, warnings)."""
    vdir = video_dir(main)
    pdir = project_dir(vdir)
    src = vdir / spec["file"]
    info = _probe(pdir, src, need=("dur",))
    warns = []
    dur = info["dur"]                                   # container duration (VFR-safe)
    for t, n in ranges:
        if t < 0 or t + float(n / rate.fps) > dur + 0.05:
            warns.append(f"b-roll {bid}: synced range {t:.2f}s+{n} frames is outside the recording")
    layout = {k: spec[k] for k in ("crop", "box", "radius", "bg", "pip") if k in spec}
    motion = spec.get("motion", "none")
    codec = spec.get("codec", "prores")
    frames = sum(n for _, n in ranges)
    ident = json.dumps([[round(t, 4), n] for t, n in ranges] + [layout, motion, rate.ff, codec], sort_keys=True)
    name = f"{bid}_{hashlib.sha1(ident.encode()).hexdigest()[:10]}_{frames}"
    mezz = pdir / "broll" / "mezz" / f"{name}.mov"
    asset = {"kind": "broll", "name": bid, "file": rel(mezz, vdir), "frames": frames, "alpha": False,
             "src_file": rel(src, vdir), "ranges": [[round(t, 4), n] for t, n in ranges], "motion": motion,
             "slot": frames, "layout": layout, "fps": rate.ff, "codec": codec}
    if "bg" in layout:
        asset["layout"]["bg"] = rel(vdir / layout["bg"], vdir)
    if "pip" in layout:
        asset["layout"]["pip"] = dict(layout["pip"], file=rel(vdir / layout["pip"]["file"], vdir))
    return f"broll:{name}", asset, 0, warns


def motion_filter(asset, W, H, fps="24000/1001"):
    n = asset["frames"]
    slot = max(1, asset["slot"])
    k = min(0.12, max(0.03, PUSH * n / slot))
    m = asset["motion"]
    if m in ("push", "pull"):
        z = f"1+{k:.5f}*on/{n}" if m == "push" else f"1+{k:.5f}*(1-on/{n})"
        x, y = "(iw-iw/zoom)/2", "(ih-ih/zoom)/2"
    elif m in ("left", "right"):
        z = f"{DRIFT_ZOOM}"
        frac = f"on/{n}" if m == "right" else f"(1-on/{n})"
        x, y = f"(iw-iw/zoom)*{frac}", "(ih-ih/zoom)/2"
    else:
        return None
    return f"zoompan=z='{z}':x='{x}':y='{y}':d=1:s={W}x{H}:fps={fps}"


def corner_mask(w, h, r, path):
    """White rounded rectangle on black (alpha mask for alphamerge)."""
    from PIL import Image, ImageDraw
    if not path.exists():
        im = Image.new("L", (w, h), 0)
        ImageDraw.Draw(im).rounded_rectangle([0, 0, w - 1, h - 1], radius=r, fill=255)
        path.parent.mkdir(parents=True, exist_ok=True)
        im.save(path)
    return path


def even(x):
    return max(2, int(round(x / 2)) * 2)


def synced_cmd(asset, base, W, H, tmp):
    """ffmpeg command for a synced b-roll: source ranges picked by timestamp, joined, laid out."""
    fps = asset["fps"]
    src = str(resolve(asset["src_file"], base))
    inputs, filters = [], []
    for k, (t, n) in enumerate(asset["ranges"]):
        inputs += ["-ss", f"{t:.4f}"] + resources.decode_args() + ["-i", src]
        filters.append(f"[{k}:v]fps={fps}:round=near,trim=end_frame={n},setpts=PTS-STARTPTS,format=yuv420p[r{k}]")
    k = len(asset["ranges"])
    joined = "".join(f"[r{i}]" for i in range(k))
    filters.append(f"{joined}concat=n={k}:v=1:a=0[cat]" if k > 1 else "[r0]null[cat]")
    lay = asset.get("layout") or {}
    info = probe(resolve(asset["src_file"], base), {})
    sw, sh = info["w"], info["h"]
    x0, y0, x1, y1 = lay.get("crop", [0, 0, 1, 1])
    cw, ch = even(sw * (x1 - x0)), even(sh * (y1 - y0))
    chain = f"[cat]crop={cw}:{ch}:{round(sw * x0)}:{round(sh * y0)}" if lay.get("crop") else "[cat]null"
    if "box" in lay:
        bx, by, bw, bh = lay["box"]
        k_fit = min(bw * W / cw, bh * H / ch)
        ow, oh = even(cw * k_fit), even(ch * k_fit)
        ox, oy = round(bx * W + (bw * W - ow) / 2), round(by * H + (bh * H - oh) / 2)
    else:
        ow, oh, ox, oy = W, H, 0, 0
    chain += f",scale={ow}:{oh}:flags=lanczos,format=yuva444p10le"
    n_in = k
    if lay.get("radius"):
        r = round(lay["radius"] * H)
        mask = corner_mask(ow, oh, r, resolve(asset["file"], base).parent / f"_mask_{ow}x{oh}_{r}.png")
        inputs += ["-loop", "1", "-i", str(mask)]
        chain += f"[sc];[{n_in}:v]format=gray[mk];[sc][mk]alphamerge"
        n_in += 1
    filters.append(chain + "[fg]")
    if lay.get("bg"):
        inputs += ["-loop", "1", "-i", str(resolve(lay["bg"], base))]
        filters.append(f"[{n_in}:v]scale={W}:{H}:flags=lanczos,format=yuva444p10le[bgi]")
    else:
        filters.append(f"color=black:s={W}x{H}:r={fps},format=yuva444p10le[bgi]")
    comp = "comp0" if lay.get("pip") else "comp"
    filters.append(f"[bgi][fg]overlay={ox}:{oy}:shortest=1,setsar=1,fps={fps}[{comp}]")
    if lay.get("pip"):
        pip_filters(lay["pip"], asset, base, fps, W, H, inputs, filters, n_in + (1 if lay.get("bg") else 0))
    mf = motion_filter(asset, W, H, fps)
    filters.append(f"[comp]{mf + ',' if mf else ''}scale={W}:{H}:flags=lanczos,format=yuv422p10le[out]")
    if asset.get("codec") == "hevc":
        filters[-1] = filters[-1].replace("format=yuv422p10le[out]", f"format={resources.pix_fmt('hevc')}[out]")
        venc = resources.video_encoder("hevc", bitrate="50M", gop=round(Fraction(fps)))
    else:
        venc = resources.video_encoder("prores", profile="standard")
    return ([tools.ffmpeg(), "-v", "error", "-y"] + inputs +
            ["-filter_complex", ";".join(filters), "-map", "[out]", "-frames:v", str(asset["frames"]), "-an",
             "-r", fps] + venc + ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
                                  "-video_track_timescale", str(Rate(fps).fcp_den)] +
            resources.ffmpeg_thread_args() + [str(tmp)])


def pip_filters(pip, asset, base, fps, W, H, inputs, filters, n_in):
    """Host circle over [comp]: the A-roll ranges matching the synced source ranges, cropped,
    masked to a circle and overlaid in the pip box: [comp0] -> [comp]."""
    src = str(resolve(pip["file"], base))
    info = probe(resolve(pip["file"], base), {})
    sw, sh = info["w"], info["h"]
    x0, y0, x1, y1 = pip["crop"]
    cw, ch = even(sw * (x1 - x0)), even(sh * (y1 - y0))
    bx, by, bw, bh = pip["box"]
    d = even(min(bw * W, bh * H))
    first = n_in
    for k, (t, n) in enumerate(asset["ranges"]):
        inputs += ["-ss", f"{t - pip['offset']:.4f}"] + resources.decode_args() + ["-i", src]
        filters.append(f"[{first + k}:v]fps={fps}:round=near,trim=end_frame={n},setpts=PTS-STARTPTS,"
                       f"format=yuv420p10le[p{k}]")
    k = len(asset["ranges"])
    joined = "".join(f"[p{i}]" for i in range(k))
    filters.append(f"{joined}concat=n={k}:v=1:a=0[pcat]" if k > 1 else "[p0]null[pcat]")
    mask = corner_mask(d, d, d // 2, resolve(asset["file"], base).parent / f"_mask_{d}x{d}_{d // 2}.png")
    inputs += ["-loop", "1", "-i", str(mask)]
    filters.append(f"[pcat]crop={cw}:{ch}:{round(sw * x0)}:{round(sh * y0)},scale={d}:{d}:flags=lanczos,"
                   f"format=yuva444p10le[pc];[{first + k}:v]format=gray[pm];[pc][pm]alphamerge[pip]")
    ox, oy = round(bx * W + (bw * W - d) / 2), round(by * H + (bh * H - d) / 2)
    filters.append(f"[comp0][pip]overlay={ox}:{oy}:shortest=1[comp]")


def render_one(asset, base, W=3840, H=2160):
    out = resolve(asset["file"], base)
    if out.exists():
        # The file name does not encode the project size: a mezzanine conformed before the
        # project's width/height changed (e.g. a sideways A-roll first probed as landscape)
        # must not be reused at the wrong size.
        got = subprocess.run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "stream=width,height", "-of", "csv=p=0", str(out)],
                             capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()
        if got == f"{W},{H}":
            return "cached"
        out.unlink()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp.mov")
    if "ranges" in asset:
        cmd = synced_cmd(asset, base, W, H, tmp)
        return _run(asset, cmd, tmp, out)
    rate = Rate(asset.get("fps", DEFAULT_FPS))
    if asset.get("realtime"):                       # pick frames by timestamp at the timeline rate
        t = asset["src_start"] / rate.fps
        vf = [f"fps={rate.ff}:round=near"]
    else:                                           # every source frame once
        fps = Fraction(asset["src_fps"])
        t = (asset["src_start"] - Fraction(1, 2)) / fps
        vf = [f"setpts=N/({rate.ff})/TB"]
    if asset.get("rotate") == 180:
        vf.append("hflip,vflip")
    elif asset.get("rotate") in (90, 270):
        vf.append("transpose=1" if asset["rotate"] == 90 else "transpose=2")
    if "crop" in asset:
        x0, y0, x1, y1 = asset["crop"]
        vf.append(f"crop=trunc(iw*{x1 - x0:.6f}/2)*2:trunc(ih*{y1 - y0:.6f}/2)*2:trunc(iw*{x0:.6f}):trunc(ih*{y0:.6f})")
    mf = motion_filter(asset, W, H, rate.ff)
    if mf:
        vf.append(mf)
    vf += [f"scale={W}:{H}:flags=lanczos", "format=yuv422p10le"]
    cmd = ([tools.ffmpeg(), "-v", "error", "-y"] + (["-ss", f"{float(t):.6f}"] if asset["src_start"] > 0 else []) +
           resources.decode_args() + ["-i", str(resolve(asset["src_file"], base)), "-map", "0:v:0", "-frames:v",
           str(asset["frames"]), "-an", "-vf", ",".join(vf), "-r", rate.ff] +
           resources.video_encoder("prores", profile="standard") +
           ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
            "-video_track_timescale", "24000" if rate.ntsc else str(rate.fcp_den)] +
           resources.ffmpeg_thread_args() + [str(tmp)])
    return _run(asset, cmd, tmp, out)


def _run(asset, cmd, tmp, out):
    with resources.gpu_task("hevc" if asset.get("codec") == "hevc" else "prores"):
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise RuntimeError(f"b-roll {asset['name']} failed:\n{' '.join(cmd)}\n{r.stderr[-1500:]}")
    got = int(subprocess.run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames",
                              "-of", "csv=p=0", str(tmp)], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip() or 0)
    if got != asset["frames"]:
        raise RuntimeError(f"b-roll {asset['name']}: {got} frames, expected {asset['frames']}")
    os.replace(tmp, out)
    return "rendered"


def render_all(tl, jobs=None, log=print):
    todo = [a for a in tl.assets.values() if a["kind"] == "broll"]
    done = {"cached": 0, "rendered": 0}
    with ThreadPoolExecutor(jobs or resources.jobs()) as ex:
        for how in ex.map(lambda a: render_one(a, tl.base, tl.width, tl.height), todo):
            done[how] += 1
    log(f"b-roll: {done['rendered']} rendered, {done['cached']} cached")
