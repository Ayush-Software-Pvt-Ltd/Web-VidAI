"""Render a Timeline: picture as cached per-shot ProRes files, sound as a sample-exact mix,
then one hardware H.264 encode.

Shots: the record timeline is cut wherever any visible layer starts or ends; each shot is
one ffmpeg command (hardware decode, crop/scale for the FCP transform, graphics overlaid by
lane) cached by the SHA-1 of the command, so only changed shots re-render.
Sound: every clip with audio is placed sample-exactly (frame boundaries on whole samples), with its
volume and fades plus 8 ms de-click fades at cuts, then one static gain to -14 LUFS
(measured on the stereo programme) and a true-peak limiter.  No noise reduction.
"""
import hashlib
import json
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import soundfile as sf

from . import resources, tools
from .model import SR, Timeline


def frame_size(tl, res):
    """Output size for a resolution class (the short side): 720, 1080 or 2160."""
    if tl.width >= tl.height:
        return round(res * tl.width / tl.height / 2) * 2, res
    return res, round(res * tl.height / tl.width / 2) * 2


def gfx_file(pdir, name, res):
    """Graphics are rendered at 1080 and 2160 (short side); previews use the 1080 set."""
    folder = "2160" if res == 2160 else "1080"
    return pdir / "gfx" / folder / f"{name}.mov"


def layer_input(tl, pdir, res, asset, src, tuning=True):
    """ffmpeg input args for a picture layer (graphic or b-roll) starting at frame `src`.
    `tuning` adds the hardware decoder and thread options (left out of the cache key)."""
    if asset["kind"] == "broll":
        dec = resources.decode_args() if tuning else []
        return seek_args(tl, src) + dec + ["-i", str(tl.path(asset["file"]))]
    return seek_args(tl, src) + ["-i", str(gfx_file(pdir, asset["name"], res))]


def seek_args(tl, frames):
    # half a frame early: the first decoded frame at or after this time is frame `frames`
    return ["-ss", tl.rate.seek(frames)] if frames > 0 else []


def geometry(scale, pos, W, H):
    """FCP transform -> (scaled width, scaled height, x, y) of a layer fitted to WxH.
    FCP scales about the frame centre; pos is in % of the frame height with +y up."""
    s = float(scale)
    sw, sh = max(2, round(W * s / 2) * 2), max(2, round(H * s / 2) * 2)
    ox = round((W - sw) / 2 + pos[0] * H / 100.0)
    oy = round((H - sh) / 2 - pos[1] * H / 100.0)
    return sw, sh, ox, oy


def crop_filter(scale, pos, W, H, src_w, src_h):
    """Punch-ins that stay inside the source become a crop of the source (sharpest path);
    returns None when the transform needs the general scale-and-overlay path."""
    sw, sh, ox, oy = geometry(scale, pos, W, H)
    if sw < W or sh < H or ox > 0 or oy > 0 or ox + sw < W or oy + sh < H:
        return None
    k = src_w / sw                                         # scaled layer -> source pixels
    cw, ch = round(W * k / 2) * 2, round(H * k / 2) * 2
    cx, cy = round(-ox * k), round(-oy * k)
    cx, cy = max(0, min(cx, src_w - cw)), max(0, min(cy, src_h - ch))
    return f"crop={cw}:{ch}:{cx}:{cy},scale={W}:{H}:flags=lanczos"


def shots_of(tl: Timeline):
    """Split the record timeline into intervals with a constant set of visible layers."""
    tl.layout()
    vids = [c for c in tl.spine] + [c for c in tl.connected if c.video and c.lane > 0]
    pts = {0, tl.duration}
    for c in vids:
        pts.add(max(0, min(c.rec, tl.duration)))
        pts.add(max(0, min(c.end, tl.duration)))
    pts = sorted(pts)
    out = []
    for a, b in zip(pts, pts[1:]):
        base = next((c for c in tl.spine if c.rec <= a < c.end), None)
        layers = sorted([c for c in tl.connected if c.video and c.lane > 0 and c.rec <= a < c.end],
                        key=lambda c: c.lane)
        out.append((a, b, base, layers))
    return out


def shot_cmd(tl, pdir, res, a, b, base, layers, out, tuning=True, encode=None):
    """The ffmpeg command for one shot.  `encode` replaces the ProRes arguments (QA frames).
    `tuning=False` leaves out everything that depends on the machine (hardware decoder, encoder
    choice, thread counts), which is what the cache key of a shot is made from."""
    W, H = frame_size(tl, res)
    n = b - a
    inputs, filters = [], []
    # drop everything under the top-most opaque full-frame graphic
    for i in range(len(layers) - 1, -1, -1):
        c = layers[i]
        if not tl.assets[c.asset].get("alpha", True) and c.scale >= 1 and tuple(c.pos) == (0.0, 0.0):
            layers = layers[i:]
            base = None
            break
    if base is not None and base.video and base.asset:
        asset = tl.assets[base.asset]
        src = base.src + (a - base.rec)
        if asset["kind"] == "aroll":
            dec = resources.decode_args() if tuning else []
            inputs += seek_args(tl, src) + dec + ["-i", str(tl.path(asset["file"]))]
            sw0, sh0 = asset["w"], asset["h"]
        else:                                              # a graphic or b-roll on the primary storyline
            inputs += layer_input(tl, pdir, res, asset, src, tuning)
            sw0, sh0 = W, H
        crop = crop_filter(base.scale, base.pos, W, H, sw0, sh0) if asset["kind"] == "aroll" else None
        turn = ""
        if asset["kind"] == "aroll" and asset.get("rotate"):
            turn = ("transpose=1," if asset["rotate"] == 90 else "transpose=2,")
        if crop:
            filters.append(f"[0:v]setpts=PTS-STARTPTS,{turn}{crop},format=yuv422p10le[v0]")
        else:
            sw, sh, ox, oy = geometry(base.scale, base.pos, W, H)
            filters.append(f"color=black:s={W}x{H}:r={tl.rate.ff},format=yuva444p10le[bk];"
                           f"[0:v]setpts=PTS-STARTPTS,{turn}scale={sw}:{sh}:flags=lanczos,format=yuva444p10le[b0];"
                           f"[bk][b0]overlay={ox}:{oy}:shortest=1,format=yuv422p10le[v0]")
    else:
        inputs += ["-f", "lavfi", "-i", f"color=black:s={W}x{H}:r={tl.rate.ff}"]
        filters.append("[0:v]format=yuv422p10le[v0]")
    cur = "v0"
    for k, c in enumerate(layers, 1):
        asset = tl.assets[c.asset]
        src = c.src + (a - c.rec)
        inputs += layer_input(tl, pdir, res, asset, src, tuning)
        sw, sh, ox, oy = geometry(c.scale, c.pos, W, H)
        filters.append(f"[{k}:v]setpts=PTS-STARTPTS,scale={sw}:{sh}:flags=lanczos,format=yuva444p10le[g{k}];"
                       f"[{cur}][g{k}]overlay={ox}:{oy}:format=auto,format=yuv422p10le[v{k}]")
        cur = f"v{k}"
    prof = "hq" if res == 2160 else "standard"
    if encode is not None:
        enc, tags = encode, []
    else:
        enc = resources.video_encoder("prores", profile=prof) if tuning else ["-c:v", "prores", "-profile:v", prof]
        tags = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
    threads = resources.ffmpeg_thread_args() if tuning else []
    return ([tools.ffmpeg(), "-v", "error", "-y"] + inputs +
            ["-filter_complex", ";".join(filters), "-map", f"[{cur}]", "-frames:v", str(n), "-an",
             "-r", tl.rate.ff] + enc + tags + threads + [str(out)])


def frame_cmd(tl, pdir, res, at, base, layers, out):
    """One composited JPEG at record frame `at` (same layers as the final render)."""
    return shot_cmd(tl, pdir, res, at, at + 1, base, layers, out, encode=["-c:v", "mjpeg", "-q:v", "3"])


def concat_line(path):
    """One line of an ffmpeg concat list: forward slashes (also fine on Windows), quote escaped."""
    return "file '{}'\n".format(Path(path).as_posix().replace("'", "'\\''"))


def render_video(tl, pdir, res, log=print):
    sdir = pdir / "build" / str(res) / "shots"
    sdir.mkdir(parents=True, exist_ok=True)
    jobs, files = [], []
    for i, (a, b, base, layers) in enumerate(shots_of(tl)):
        probe = shot_cmd(tl, pdir, res, a, b, base, layers, "OUT", tuning=False)
        # key = the command plus the identity of every input file, so a re-rendered
        # graphic at the same path invalidates the shots that use it
        stamp = [(x, os.stat(x).st_size, os.stat(x).st_mtime_ns) for x in probe if os.path.isfile(x)]
        h = hashlib.sha1(json.dumps([probe, stamp]).encode()).hexdigest()[:12]
        out = sdir / f"shot_{h}.mov"
        files.append((out, b - a))
        if not out.exists():
            jobs.append((i, shot_cmd(tl, pdir, res, a, b, base, layers, out.with_suffix(".tmp.mov")), out))
    log(f"shots: {len(files)} total, {len(jobs)} to render")

    def run(job):
        i, cmd, out = job
        with resources.gpu_task("prores"):
            r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL)
        if r.returncode != 0:
            raise RuntimeError(f"shot {i} failed:\n{' '.join(cmd)}\n{r.stderr[-2000:]}")
        os.replace(out.with_suffix(".tmp.mov"), out)
        return i

    with ThreadPoolExecutor(resources.jobs()) as ex:
        for _ in ex.map(run, jobs):
            pass
    # verify frame counts of every shot
    bad = []
    for f, n in files:
        got = int(subprocess.run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries",
                                  "stream=nb_frames", "-of", "csv=p=0", str(f)],
                                 capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip() or 0)
        if got != n:
            bad.append((f.name, n, got))
    if bad:
        raise RuntimeError(f"shot frame counts differ: {bad[:5]}")
    lst = pdir / "build" / str(res) / "concat.txt"
    lst.write_text("".join(concat_line(f) for f, _ in files), encoding="utf-8")
    keep = {f.name for f, _ in files}
    for f in sdir.glob("shot_*.mov"):
        if f.name not in keep:
            f.unlink()
    return lst


# ------------------------------------------------------------------ audio

def loudness(wav):
    r = subprocess.run([tools.ffmpeg(), "-hide_banner", "-nostats", "-i", str(wav), "-af", "ebur128=peak=true",
                        "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
    summ = r[r.rfind("Summary:"):]
    i = float(re.search(r"I:\s+(-?[\d.]+) LUFS", summ).group(1))
    tp = float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", summ).group(1))
    return i, tp


def render_audio(tl, pdir, res, target=-14.0, log=print):
    smp = tl.rate.samples                          # frame -> sample index
    total = smp(tl.duration)
    mix = np.zeros((total, 2), dtype=np.float64)
    cache = {}

    def source(key):
        if key not in cache:
            a = tl.assets[key]
            if a["kind"] == "aroll":
                path = tl.path(a["audio"]) if "audio" in a else pdir / "audio" / "a1_48k.wav"
            else:
                path = tl.path(a["file"])
            x, sr = sf.read(str(path), dtype="float64", always_2d=True)
            assert sr == SR
            cache[key] = x if x.shape[1] == 2 else np.repeat(x, 2, axis=1)
        return cache[key]

    clips = [c for c in tl.spine if c.audio and c.asset] + [c for c in tl.connected if c.audio and c.asset]
    spine = [c for c in tl.spine]
    declick = int(0.008 * SR)
    for c in clips:
        a = tl.assets[c.asset]
        if a["kind"] in ("gfx", "broll"):
            continue
        x = source(c.asset)
        s0 = smp(c.src)
        r0 = smp(c.rec)
        n = smp(c.rec + c.dur) - r0
        seg = np.zeros((n, 2))
        avail = x[s0:s0 + n]
        seg[:len(avail)] = avail
        g = np.ones(n)
        # de-click fades unless the neighbour on the spine continues the same source
        idx = spine.index(c) if c in spine else -1
        cont_prev = idx > 0 and spine[idx - 1].asset == c.asset and spine[idx - 1].src + spine[idx - 1].dur == c.src \
            and spine[idx - 1].audio
        cont_next = 0 <= idx < len(spine) - 1 and spine[idx + 1].asset == c.asset and c.src + c.dur == spine[idx + 1].src \
            and spine[idx + 1].audio
        if a["kind"] == "aroll":
            if not cont_prev:
                g[:declick] *= np.linspace(0, 1, declick)
            if not cont_next:
                g[-declick:] *= np.linspace(1, 0, declick)
        if c.fade_in:
            k = min(n, smp(c.fade_in))
            g[:k] *= np.sin(np.linspace(0, np.pi / 2, k)) ** 2
        if c.fade_out:
            k = min(n, smp(c.fade_out))
            g[-k:] *= np.cos(np.linspace(0, np.pi / 2, k)) ** 2
        g *= 10 ** (c.volume_db / 20)
        r1 = min(total, r0 + n)
        mix[r0:r1] += (seg * g[:, None])[: r1 - r0]

    adir = pdir / "build" / str(res)
    adir.mkdir(parents=True, exist_ok=True)
    raw = adir / "mix_raw.wav"
    sf.write(str(raw), mix.astype(np.float32), SR, subtype="FLOAT")
    i0, _ = loudness(raw)
    gain = target - i0
    out = adir / "mix.wav"
    for _ in range(3):
        subprocess.run([tools.ffmpeg(), "-v", "error", "-y", "-i", str(raw), "-af",
                        f"volume={gain:.3f}dB,alimiter=limit=0.8414:attack=5:release=60:level=disabled,"
                        f"aresample=48000", "-c:a", "pcm_s24le"] + resources.ffmpeg_thread_args() + [str(out)],
                       check=True)
        i1, tp = loudness(out)
        if abs(i1 - target) <= 0.1:
            break
        gain += target - i1
    log(f"audio: mix {i0:.1f} LUFS, static gain {gain:+.2f} dB -> {i1:.1f} LUFS, true peak {tp:.1f} dBTP")
    return out, {"lufs": i1, "true_peak": tp, "gain_db": gain}


def video_bitrate(path):
    out = subprocess.run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=bit_rate",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()
    return int(out or 0)


def duration_of(path):
    return float(subprocess.run([tools.ffprobe(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                 str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip() or 0)


def mux(concat, audio, out, res, fps="24000/1001", log=print):
    """Hardware H.264 delivery at a target bitrate (6 / 12 / 40 Mbps for 720 / 1080 / 2160).

    h264_videotoolbox treats -b:v as a loose ceiling and, on this macOS, ignores
    -constant_bit_rate (a 40M request gave 11 Mbps on talking head).  So: encode at the
    target; if the delivered bitrate is more than 15 % off, calibrate the quality scale
    (-q:v) on three samples of the edit, re-encode with it and measure again."""
    out.parent.mkdir(parents=True, exist_ok=True)
    mbps = {720: 6, 1080: 12, 2160: 40}[res]
    target = mbps * 1_000_000
    head = [tools.ffmpeg(), "-v", "error", "-y", "-f", "concat", "-safe", "0"]
    tags = ["-r", fps, "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
    tail = resources.audio_encoder("320k") + ["-movflags", "+faststart", "-shortest"]
    threads = resources.ffmpeg_thread_args()

    def encode(rate, dst):
        """`rate` = {"bitrate": "40M"} or {"quality": q}."""
        venc = resources.video_encoder("h264", **rate)
        cmd = (head + ["-i", str(concat), "-i", str(audio), "-map", "0:v", "-map", "1:a"] + venc + tags +
               tail + threads + [str(dst)])
        with resources.gpu_task("h264"):
            r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
            if r.returncode != 0 and "constant_bit_rate" in r.stderr and "-constant_bit_rate" in cmd:
                i = cmd.index("-constant_bit_rate")
                del cmd[i:i + 2]
                r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise RuntimeError(r.stderr[-2000:])

    br = f"{mbps}M"
    encode({"bitrate": br}, out)
    got = video_bitrate(out)
    if not resources.is_loose_rate() or abs(got - target) <= 0.15 * target:
        # only VideoToolbox misses the target; the other encoders hold the bitrate they are given
        log(f"wrote {out} ({got / 1e6:.1f} Mbps)")
        return out
    log(f"encoder gave {got / 1e6:.1f} Mbps for {mbps}M; calibrating the quality scale")
    total = duration_of(out)
    samples = [total * f for f in (0.2, 0.5, 0.8)]
    tmp = out.parent / ".calib.mp4"

    def sample_rate(q):
        bits = 0.0
        for t in samples:
            cmd = [tools.ffmpeg(), "-v", "error", "-y", "-ss", f"{t:.2f}", "-t", "8", "-f", "concat", "-safe", "0",
                   "-i", str(concat), "-an"] + resources.video_encoder("h264", quality=q) + tags + threads + [str(tmp)]
            with resources.gpu_task("h264"):
                subprocess.run(cmd, check=True, capture_output=True)
            bits += video_bitrate(tmp)
        return bits / len(samples)

    import math
    q_lo, q_hi = 60, 85
    r_lo, r_hi = sample_rate(q_lo), sample_rate(q_hi)
    for attempt in range(3):
        # bitrate grows roughly exponentially with q: interpolate log(rate)
        k = (math.log(target) - math.log(r_lo)) / (math.log(r_hi) - math.log(r_lo))
        q = max(1, min(100, round(q_lo + k * (q_hi - q_lo))))
        encode({"quality": q}, out)
        got = video_bitrate(out)
        log(f"  -q:v {q}: {got / 1e6:.1f} Mbps")
        if abs(got - target) <= 0.15 * target:
            break
        if got < target:
            q_lo, r_lo = q, got
        else:
            q_hi, r_hi = q, got
    tmp.unlink(missing_ok=True)
    log(f"wrote {out} ({got / 1e6:.1f} Mbps)")
    return out
