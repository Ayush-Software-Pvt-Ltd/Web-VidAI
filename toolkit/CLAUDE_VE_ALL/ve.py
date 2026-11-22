"""Video edit driver.  Every command takes the video folder as an absolute path (a relative one is
resolved against the current directory); the folder lies anywhere.  The toolkit is found from this
file's own location and only read; the working files are written to <video folder>/CLAUDE_VE/ and
the deliverables to <video folder>/output/.  Run it with the toolkit's own Python:

  PY=<data dir>/toolkit/venv/bin/python        (Windows: <data dir>\\toolkit\\venv\\Scripts\\python.exe)
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py doctor                    check ffmpeg / hardware encoders / node / speech package
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py hardware                  speech device and video encoder as one JSON line (System page)
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py prep   <VIDEO>            recon the video folder, write project.json, extract audio
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py lang   <VIDEO>            spoken language of each A-roll (after prep)
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py plan   <VIDEO>            timeline.py -> build/timeline.json (+ warnings, pacing)
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py gfx    <VIDEO> [--res 1080]   render the graphics the timeline uses (720 or 1080 only)
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py broll  <VIDEO>            conform the b-roll mezzanines only
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py build  <VIDEO> --res 720|1080 [--timeline FILE]
                                                    render picture + sound + encode
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py hf     <VIDEO>            HyperFrames project <VIDEO>/output/<name>.hf/ (the deliverable)
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py review <VIDEO>            the same as hf
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py fcp    <VIDEO>            Final Cut Pro review project (FCPXML 1.14)
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py premiere <VIDEO>          Premiere Pro review project (FCP7 XML)
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py import <VIDEO> <export.fcpxml|.fcpxmld|.xml>
                                                    read the creator's export -> build/timeline_fcp.json
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py frames <VIDEO> --res 720    one composited frame per shot + contact sheets
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py audio  <VIDEO>            render the mix only (loudness check / QA transcription)
  $PY <toolkit>/CLAUDE_VE_ALL/ve.py qa     <VIDEO> --res 720|1080       contact sheets + pacing + loudness of a render

Environment (all optional): VE_CHANNEL_DIR, VE_CPU_CORES, VE_GPU_SLOTS_DIR, VE_JOB_ID, VE_HW, VE_FFMPEG,
VE_FFPROBE, VE_NPX, VE_NODE, VE_HYPERFRAMES, VE_ASR_BACKEND, VE_ASR_DEVICE, VE_FONT, VE_ALLOW_2160 (see vekit/resources.py and vekit/asr.py).
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vekit import asr, broll, fcpxml, gfx, hfproject, premiere, qa, render, resources, tools  # noqa: E402
from vekit.model import Timeline  # noqa: E402
from vekit.paths import DTD, KIT, project_dir, rel, video_dir  # noqa: E402
from vekit.plan import plan  # noqa: E402


def pdir_of(main):
    return project_dir(main)


def pacing(tl):
    """Visible shot lengths (spine framings and lane-1 graphics) for the pacing report."""
    rows = []
    for a, b, base, layers in render.shots_of(tl):
        full = [c for c in layers if c.lane == 1]
        label = full[-1].name if full else ("host x%.2f" % base.scale if base else "black")
        if rows and rows[-1][2] == label and rows[-1][1] == a:
            rows[-1][1] = b
        else:
            rows.append([a, b, label])
    return rows


VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".mts", ".m2ts", ".avi", ".webm"}


def probe_media(path):
    out = subprocess.run([tools.ffprobe(), "-v", "error", "-show_streams", "-show_format", "-of", "json",
                          str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace", check=True).stdout
    d = json.loads(out)
    v = next((s for s in d["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in d["streams"] if s["codec_type"] == "audio"), None)
    if not v:
        raise RuntimeError(f"no video stream: {path}")
    rot = 0
    for sd in v.get("side_data_list", []):
        if "rotation" in sd:
            rot = int(sd["rotation"])
    rot = int(v.get("tags", {}).get("rotate", rot) or 0)
    w, h = int(v["width"]), int(v["height"])
    if abs(rot) % 180 == 90:
        w, h = h, w
    fps = v.get("r_frame_rate") or "24000/1001"
    dur = float(d["format"].get("duration") or 0)
    n = int(v.get("nb_frames") or 0) or int(round(dur * float(Fraction(fps))))
    return {"file": str(path), "w": w, "h": h, "rot": rot, "fps": fps, "dur": dur, "frames": n,
            "vcodec": v.get("codec_name"), "pix_fmt": v.get("pix_fmt"),
            "audio": bool(a), "achannels": int(a.get("channels", 0)) if a else 0,
            "asr": int(a.get("sample_rate", 0)) if a else 0,
            "timecode": next((s.get("tags", {}).get("timecode") for s in d["streams"]
                              if s.get("codec_tag_string") == "tmcd"), None)}


def cmd_prep(a):
    """Recon the video folder, write project.json, extract the A-roll audio."""
    pdir = pdir_of(a.main)
    vdir = video_dir(a.main)
    if not vdir.is_dir():
        raise SystemExit(f"no such video folder: {vdir}")
    for d in ("audio", "gfx_src", "transcripts", "build", "assets", "broll", "thumb_src"):
        (pdir / d).mkdir(parents=True, exist_ok=True)

    # A-roll = Main.* / Main2.* / A-roll* at the top of the video folder; else the largest video
    vids = [p for p in sorted(vdir.iterdir()) if p.is_file() and p.suffix.lower() in VIDEO_EXT]
    named = [p for p in vids if p.stem.lower().startswith(("main", "a-roll", "aroll", "part"))]
    parts = named or sorted(vids, key=lambda p: p.stat().st_size, reverse=True)[:1]
    if not parts:
        raise SystemExit(f"no A-roll video found in {vdir}")
    parts = sorted(parts, key=lambda p: (len(p.stem), p.name))

    pj = pdir / "project.json"
    project = json.loads(pj.read_text(encoding="utf-8")) if pj.exists() else {}
    infos = {f"a{i}": probe_media(p) for i, p in enumerate(parts, 1)}

    first = infos["a1"]
    W, H = (3840, 2160) if first["w"] >= first["h"] else (2160, 3840)
    fps = str(Fraction(first["fps"]))
    project.setdefault("width", W)
    project.setdefault("height", H)
    project["fps"] = fps
    project["aroll"] = {k: Path(v["file"]).name for k, v in infos.items()}
    project["aroll_frames"] = {k: v["frames"] for k, v in infos.items()}
    project.setdefault("final_name", "final_4k.mp4")
    project.setdefault("voice_gain_db", 0.0)
    project.setdefault("tight_scale", 1.18)
    project.setdefault("tight_anchor", [0.5, 0.30])
    project.setdefault("head_top", 0.235)
    project.setdefault("min_framing_frames", 12)
    project.setdefault("energy_threshold_db", -38)
    project.setdefault("hit_template", "hot_hit_16x9" if W > H else "hot_hit")
    project.setdefault("end_template", "end_fade_16x9" if W > H else "end_fade")
    project.setdefault("hit_media_seconds", 6.0)
    project.setdefault("hit_lane", 3)
    project.setdefault("end_lane", 4)
    project.setdefault("sfx_whoosh_db", -12.0)
    project.setdefault("sfx_pop_db", -14.0)
    project.setdefault("whoosh_on", "all")
    pj.write_text(json.dumps(project, indent=1), encoding="utf-8")

    for k, v in infos.items():
        src = Path(v["file"])
        w48 = pdir / "audio" / f"{k}_48k.wav"
        w16 = pdir / "audio" / f"{k}_16k.wav"
        subprocess.run([tools.ffmpeg(), "-v", "error", "-y", "-i", str(src), "-vn", "-ac", "2", "-ar", "48000",
                        "-c:a", "pcm_s24le", str(w48)], check=True)
        subprocess.run([tools.ffmpeg(), "-v", "error", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
                        "-c:a", "pcm_s16le", str(w16)], check=True)
        v["audio_48k"] = rel(w48, vdir)
        v["audio_16k"] = rel(w16, vdir)
        print(f"{k}  {src.name}  {v['w']}x{v['h']} (rot {v['rot']})  {v['fps']}  "
              f"{v['dur']:.2f}s  {v['frames']} frames  {v['vcodec']} {v['pix_fmt']}  "
              f"audio {'yes' if v['audio'] else 'NO'}"
              + (f"  tc {v['timecode']}" if v["timecode"] else ""))

    (pdir / "build" / "recon.json").write_text(json.dumps(infos, indent=1), encoding="utf-8")
    print(f"project {project['width']}x{project['height']} @ {fps} -> {pj}")

    others = [p for p in sorted(vdir.rglob("*")) if p.is_file() and p.suffix.lower() in VIDEO_EXT
              and p not in parts and "CLAUDE_VE" not in p.parts and "output" not in p.parts]
    if others:
        print(f"{len(others)} other video file(s) to catalogue as b-roll:")
        for p in others:
            print("  ", p.relative_to(vdir))


def cmd_lang(a):
    """The spoken language of each A-roll: Whisper's guess on three windows, printed with its probability."""
    import soundfile as sf
    pdir = pdir_of(a.main)
    try:
        project = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit("no project.json: run ve.py prep first")
    with asr.gpu_task():
        for k in project["aroll"]:
            wav = pdir / "audio" / f"{k}_16k.wav"
            audio, sr = sf.read(str(wav), dtype="float32")
            assert sr == 16000, "expects 16 kHz mono"
            print(f"{k}  {asr.describe_language(asr.detect_language(audio, model=a.model))}", flush=True)


def cmd_plan(a):
    tl, warns = plan(a.main)
    f2s = tl.f2s
    rows = pacing(tl)
    lens = [f2s(b - s) for s, b, _ in rows]
    nb = sum(1 for c in tl.connected if c.lane == 1 and tl.assets[c.asset]["kind"] == "broll")
    print(f"duration {f2s(tl.duration):.2f}s, {len(tl.spine)} spine clips, "
          f"{sum(1 for c in tl.connected if c.lane == 1) - nb} graphics, {nb} b-roll, "
          f"{sum(1 for c in tl.connected if c.asset.startswith('gfx:hit_'))} hits, "
          f"{sum(1 for c in tl.connected if c.lane == 2 and not c.asset.startswith('gfx:hit_'))} overlays")
    print(f"visible shots {len(rows)}, mean {sum(lens) / len(lens):.2f}s, max {max(lens):.2f}s")
    if a.verbose:
        for s, b, label in rows:
            flag = "  <-- long" if f2s(b - s) > 3.2 and not label.startswith("check") else (
                "  <-- short" if f2s(b - s) < 0.6 else "")
            print(f"  {f2s(s):7.2f} {f2s(b - s):5.2f}s  {label}{flag}")
    for w in warns:
        print("WARN", w)
    # synced b-roll (a second angle such as a screen recording) is different footage every time
    # and a graphic resumed after a cut to the host (in-point > 0) is the same use continuing
    names = [c.name for c in tl.connected if c.lane == 1 and "ranges" not in tl.assets[c.asset]
             and not (tl.assets[c.asset]["kind"] == "gfx" and c.src > 0)]
    for n in sorted(set(names)):
        if names.count(n) > 2:
            print("WARN graphic/b-roll used more than twice:", n)


def load_tl(a):
    p = Path(a.timeline).resolve() if getattr(a, "timeline", None) else pdir_of(a.main) / "build" / "timeline.json"
    return Timeline.load(p, base=video_dir(a.main))


def cmd_gfx(a):
    tl = load_tl(a)
    gfx.render_all(tl, pdir_of(a.main), [resources.check_resolution(r) for r in a.res], force=a.force)


def cmd_broll(a):
    tl = load_tl(a)
    broll.render_all(tl)


def cmd_build(a):
    main, res = a.main, resources.check_resolution(a.res)
    pdir = pdir_of(main)
    tl = load_tl(a)
    project = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    gfx.render_all(tl, pdir, [2160 if res == 2160 else 1080])
    broll.render_all(tl)
    concat = render.render_video(tl, pdir, res)
    audio, loud = render.render_audio(tl, pdir, res)
    if res == 2160:
        out = video_dir(main) / "output" / project["final_name"]
    else:
        out = pdir / "renders" / f"preview_{res}.mp4"
    render.mux(concat, audio, out, res, tl.rate.ff)
    info = subprocess.run([tools.ffprobe(), "-v", "error", "-show_entries",
                           "stream=codec_name,width,height,r_frame_rate,bit_rate:format=duration,bit_rate",
                           "-of", "compact", str(out)], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    print(info.strip())
    (pdir / "build" / str(res) / "render_info.json").write_text(json.dumps({"out": str(out), **loud}, indent=1),
                                                                encoding="utf-8")


def _validate_fcp(out):
    if DTD.exists() and shutil.which("xmllint"):
        r = subprocess.run(["xmllint", "--noout", "--dtdvalid", str(DTD), str(out)], capture_output=True,
                           text=True, encoding="utf-8", errors="replace")
        print("DTD validation:", "OK" if r.returncode == 0 else r.stderr[-2000:])


def cmd_fcp(a):
    pdir = pdir_of(a.main)
    tl = load_tl(a)
    gfx.render_all(tl, pdir, [1080])
    broll.render_all(tl)
    name = video_dir(a.main).name
    # the review project is a deliverable: it goes to <MAIN>/output/ (creator's rule, 2026-10-16);
    # its media stay in CLAUDE_VE
    out = video_dir(a.main) / "output" / f"{name}_review_{a.version}.fcpxml"
    out.parent.mkdir(parents=True, exist_ok=True)
    fcpxml.write(tl, out, f"{name} review {a.version}", pdir / "gfx" / "1080")
    _validate_fcp(out)
    # round-trip self check: reading our own file must give back the same timeline
    warns = []
    back = fcpxml.read(out, tl.assets, warns, tl.fps, base=tl.base)
    same = diff(tl, back)
    print("round trip:", "identical" if not same else "\n  ".join(["DIFFERS"] + same))
    for w in warns:
        print("WARN", w)
    print(out)


def cmd_premiere(a):
    pdir = pdir_of(a.main)
    tl = load_tl(a)
    gfx.render_all(tl, pdir, [1080])
    broll.render_all(tl)
    name = video_dir(a.main).name
    out = video_dir(a.main) / "output" / f"{name}_review_{a.version}.xml"
    out.parent.mkdir(parents=True, exist_ok=True)
    premiere.write(tl, out, f"{name} review {a.version}", pdir / "gfx" / "1080")
    problems = premiere.check(out)
    print("media check:", "OK" if not problems else "\n  ".join(["PROBLEMS"] + problems[:20]))
    n = len(list(ET.parse(out).getroot().iter("clipitem")))
    print(f"{n} clipitems, sequence {tl.f2s(tl.duration):.2f}s")
    print(out)


def cmd_hf(a):
    """The HyperFrames project of the edit; no graphics or b-roll are rendered for it."""
    try:
        out = hfproject.export(a.main, load_tl(a))
    except hfproject.ExportError as e:
        print(f"ERROR {e}", file=sys.stderr)
        return 1
    print(out)


def cmd_review(a):
    return cmd_hf(a)


def diff(t1, t2):
    out = []
    key = lambda c: (c.rec, c.lane, c.asset, c.src, c.dur, round(c.scale, 4), tuple(round(v, 3) for v in c.pos),
                     round(c.volume_db, 2), c.fade_in, c.fade_out, c.video, c.audio)
    a = sorted(key(c) for c in t1.spine + t1.connected)
    b = sorted(key(c) for c in t2.spine + t2.connected)
    for x in a:
        if x not in b:
            out.append(f"only in ours: {x}")
    for x in b:
        if x not in a:
            out.append(f"only in FCP:  {x}")
    if t1.duration != t2.duration:
        out.append(f"duration {t1.duration} vs {t2.duration} frames")
    return out


def cmd_import(a):
    pdir = pdir_of(a.main)
    vdir = video_dir(a.main)
    ours = Timeline.load(pdir / "build" / "timeline.json", base=vdir)
    warns = []
    if str(a.export).lower().endswith(".xml"):
        tl = premiere.read(a.export, ours.assets, warns, ours.fps, base=vdir)
    else:
        tl = fcpxml.read(a.export, ours.assets, warns, ours.fps, base=vdir)
    tl.meta = {"main": str(vdir), "source": str(Path(a.export).resolve())}
    out = pdir / "build" / "timeline_fcp.json"
    tl.save(out)
    d = diff(ours, tl)
    print(f"review timeline: {tl.f2s(tl.duration):.2f}s ({tl.duration} frames), {len(tl.spine)} spine items, "
          f"{len(tl.connected)} connected")
    print(f"{len(d)} differences from the exported review timeline")
    for x in d[:200]:
        print("  ", x)
    for w in warns:
        print("WARN", w)
    print(out)


def shot_label(tl, base, layers):
    full = [c for c in layers if c.lane == 1]
    if full:
        return full[-1].name
    if base is None:
        return "black"
    return "host x%.2f" % base.scale


def cmd_frames(a):
    tl = load_tl(a)
    pdir = pdir_of(a.main)
    res = resources.check_resolution(a.res)
    outdir = pdir / "build" / str(res) / "qa_frames"
    outdir.mkdir(parents=True, exist_ok=True)
    shots = render.shots_of(tl)
    items, sheet_no = [], 1
    for i, (s, b, base, layers) in enumerate(shots):
        mid = s + max(0, (b - s) // 2)
        out = outdir / f"shot_{i:03d}.jpg"
        cmd = render.frame_cmd(tl, pdir, res, mid, base, layers, out)
        with resources.gpu_task():
            r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL)
        if r.returncode != 0:
            raise RuntimeError(f"frame {i} failed:\n{' '.join(cmd)}\n{r.stderr[-1500:]}")
        items.append((out, f"{tl.f2s(s):.1f}s {shot_label(tl, base, layers)}"))
    sheets = []
    for k in range(0, len(items), 36):
        sheet = pdir / "build" / str(res) / f"qa_sheet_{sheet_no}.jpg"
        qa.tile(items[k:k + 36], sheet, cols=6, width=300)
        sheets.append(sheet)
        sheet_no += 1
    for s in sheets:
        print(s)
    print(f"{len(items)} shots, {len(sheets)} sheets")


def cmd_audio(a):
    tl = load_tl(a)
    pdir = pdir_of(a.main)
    mix, loud = render.render_audio(tl, pdir, 720)
    print(mix)
    print(f"loudness {loud['lufs']:.1f} LUFS, true peak {loud['true_peak']:.1f} dBTP")


def cmd_qa(a):
    pdir = pdir_of(a.main)
    project = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    res = resources.check_resolution(a.res)
    out = video_dir(a.main) / "output" / project["final_name"] if res == 2160 else pdir / "renders" / f"preview_{res}.mp4"
    tl = load_tl(a)
    rows = pacing(tl)
    mids = [round(tl.f2s((s + b) // 2), 3) for s, b, _ in rows]
    qdir = pdir / "build" / str(res) / "qa"
    qdir.mkdir(parents=True, exist_ok=True)
    for i in range(0, len(mids), 40):
        subprocess.run([sys.executable, str(KIT / "sheet.py"), str(out),
                        str(qdir / f"shots_{i // 40 + 1}.jpg"), "--times", ",".join(map(str, mids[i:i + 40])),
                        "--cols", "10", "--width", "200"], check=True)
    i, tp = render.loudness(out)
    print(f"loudness {i:.1f} LUFS, true peak {tp:.1f} dBTP")


def cmd_doctor(a):
    """What this computer offers: programs, the hardware encoders ffmpeg can really use, speech."""
    ok = True
    for exe, wanted in (("ffmpeg", tools.ffmpeg()), ("ffprobe", tools.ffprobe()), ("node", tools.node()),
                        ("npx", tools.npx())):
        p = shutil.which(wanted)
        print(f"{exe:8s} {'OK  ' + p if p else 'MISSING'}")
        ok &= bool(p)
    p = shutil.which("xmllint")                     # only checks the FCPXML against its DTD
    print(f"{'xmllint':8s} {'OK  ' + p if p else 'missing (optional: FCPXML is not validated)'}")
    if shutil.which(tools.ffmpeg()):
        print("hardware", resources.backend("h264"), "(VE_HW picks another; none forces software)")
        for kind in ("h264", "hevc", "prores"):
            print(f"encoder {kind:7s} {resources.video_encoder_name(kind)}")
        print(f"encoder {'audio':7s} {resources.audio_encoder_name()}")
        print("decoder  ", " ".join(resources.hwaccel_args()) or "software")
        for f in resources.describe_video()["failed"]:
            print(f"hardware {f['encoder']} is offered by ffmpeg but did not start: {f['error']}")
    which = asr.backend()
    try:
        __import__("mlx_whisper" if which == "mlx" else "faster_whisper")
        info = asr.describe()
        print(f"speech   OK  {which}, device {asr.device()}, {info['summary']}")
        if info["problem"]:                       # an NVIDIA GPU that CUDA cannot use yet is not READY
            print(f"speech   MISSING (cuda): {info['problem']}")
            ok = False
    except Exception as e:
        print(f"speech   MISSING ({which}): {e}")
        ok = False
    print("platform", platform.system(), platform.machine(), "python", platform.python_version())
    print("cores", resources.cores(), "jobs", resources.jobs(), "ffmpeg threads", resources.ffmpeg_threads())
    print("toolkit", KIT)
    print("result:", "READY" if ok else "INCOMPLETE")
    return 0 if ok else 1


def cmd_hardware(a):
    """The speech device and the video encoding as one JSON line (the System page reads it)."""
    speech = asr.describe()
    video = resources.describe_video() if shutil.which(tools.ffmpeg()) else None
    print(json.dumps({"speech": speech, "video": video}))
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan"); p.add_argument("main"); p.add_argument("-v", "--verbose", action="store_true")
    p = sub.add_parser("gfx"); p.add_argument("main"); p.add_argument("--res", nargs="+", default=["1080"])
    p.add_argument("--force", action="store_true"); p.add_argument("--timeline")
    p = sub.add_parser("broll"); p.add_argument("main"); p.add_argument("--timeline")
    p = sub.add_parser("build"); p.add_argument("main"); p.add_argument("--res", required=True); p.add_argument("--timeline")
    p = sub.add_parser("fcp"); p.add_argument("main"); p.add_argument("--version", default="v1"); p.add_argument("--timeline")
    p = sub.add_parser("premiere"); p.add_argument("main"); p.add_argument("--version", default="v1"); p.add_argument("--timeline")
    p = sub.add_parser("hf"); p.add_argument("main"); p.add_argument("--timeline")
    p = sub.add_parser("review"); p.add_argument("main"); p.add_argument("--timeline")
    p = sub.add_parser("import"); p.add_argument("main"); p.add_argument("export")
    p = sub.add_parser("frames"); p.add_argument("main"); p.add_argument("--res", default="720"); p.add_argument("--timeline")
    p = sub.add_parser("audio"); p.add_argument("main"); p.add_argument("--timeline")
    p = sub.add_parser("qa"); p.add_argument("main"); p.add_argument("--res", required=True); p.add_argument("--timeline")
    p = sub.add_parser("prep"); p.add_argument("main")
    p = sub.add_parser("lang"); p.add_argument("main"); p.add_argument("--model", default="large-v3", choices=list(asr.MODELS))
    sub.add_parser("doctor")
    sub.add_parser("hardware")
    a = ap.parse_args()
    sys.exit(asr.guarded(lambda: {"prep": cmd_prep, "plan": cmd_plan, "gfx": cmd_gfx, "broll": cmd_broll, "build": cmd_build,
     "fcp": cmd_fcp, "premiere": cmd_premiere, "hf": cmd_hf,
     "review": cmd_review, "import": cmd_import, "frames": cmd_frames, "audio": cmd_audio,
     "lang": cmd_lang, "qa": cmd_qa, "doctor": cmd_doctor, "hardware": cmd_hardware}[a.cmd](a) or 0))


if __name__ == "__main__":
    main()
