"""Render every graphic a timeline uses (HyperFrames -> ProRes 4444 with alpha).

Sources:
  <MAIN>/CLAUDE_VE/gfx_src/<name>/        per-video compositions
  CLAUDE_VE_ALL/gfx/templates/<hit_template>   keyword hits / pop-ups, variables from hits.json
                                          (project.json "hit_template", default "hit")
  CLAUDE_VE_ALL/gfx/templates/end_fade    fade to black
Outputs: <MAIN>/CLAUDE_VE/gfx/<1080|2160>/<name>.mov (short side), exactly the timeline's
frame rate; portrait projects use portrait-4k, landscape projects landscape-4k for the 2160 set.
23.976 timelines: HyperFrames renders at 24 fps and the file is re-timed 1:1 (same frames,
0.1 % slower) with a lossless two-step remux.  Other rates (25, 30, ...) render natively.
Each output is cached by a hash of its inputs.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import resources, tools
from .paths import SHARED, TEMPLATES
HF = tools.HYPERFRAMES_PACKAGE
SKIP = {".hyperframes", "renders", "node_modules", "shared"}


# Channel design kits live in their own top-level folders of the shared kit (for example
# _shared/moi for Moi Phone).  A kit folder only enters a graphic's cache key when the graphic
# references it ("shared/moi/"), so adding a channel kit never invalidates other channels' renders.
KITS = {"moi", "moi9", "hot", "at", "xxx", "hoa"}


def files_hash(*dirs, extra="", skip=()):
    h = hashlib.sha1(extra.encode())
    for d in dirs:
        for p in sorted(Path(d).rglob("*")):
            if p.is_file() and not (set(p.relative_to(d).parts) & (SKIP | set(skip))):
                h.update(p.relative_to(d).as_posix().encode())
                h.update(p.read_bytes())
    return h.hexdigest()


def unused_kits(src):
    html = (Path(src) / "index.html").read_text(encoding="utf-8")
    return {k for k in KITS if f"shared/{k}/" not in html}


def declared_vars(src):
    """Variable ids a composition declares, so an optional key the template does not use
    cannot abort the whole render (HyperFrames runs with --strict-variables)."""
    html = (Path(src) / "index.html").read_text(encoding="utf-8")
    m = re.search(r"data-composition-variables='([^']*)'", html)
    if not m:
        return set()
    try:
        return {v["id"] for v in json.loads(m.group(1)) if "id" in v}
    except (ValueError, TypeError):
        return set()


def jobs_for(tl, pdir, resolutions):
    hits = json.loads((pdir / "hits.json").read_text(encoding="utf-8")) if (pdir / "hits.json").exists() else {}
    pj = pdir / "project.json"
    proj = json.loads(pj.read_text(encoding="utf-8")) if pj.exists() else {}
    hit_tpl = proj.get("hit_template", "hit")
    end_tpl = proj.get("end_template", "end_fade")
    four_k = "portrait-4k" if tl.height > tl.width else "landscape-4k"
    jobs = []
    for key, a in tl.assets.items():
        if a["kind"] != "gfx":
            continue
        name = a["name"]
        if name.startswith("hit_"):
            v = hits[name]
            src, variables = TEMPLATES / hit_tpl, (v if isinstance(v, dict) else {"text": v})
        elif name == "end_fade":
            src, variables = TEMPLATES / end_tpl, None
        else:
            src, variables = pdir / "gfx_src" / name, None
        for res in resolutions:
            jobs.append((name, src, variables, res, four_k, tl.rate))
    return jobs


def link_shared(link):
    """Make `link` show the toolkit's single shared graphics folder inside a render's work copy.

    The templates say `shared/...`; only one copy of that folder is in the toolkit (git cannot keep
    symlinks portably).  A tree of hard links (no data copied), else a plain copy.  Not a symbolic link:
    HyperFrames 0.9 serves the project folder to its browser and answers 404 for a file reached through a
    link that leaves the folder.
    """
    try:
        shutil.copytree(SHARED, link, copy_function=os.link)
    except OSError:
        if link.exists() or link.is_symlink():
            shutil.rmtree(link, ignore_errors=True)
        shutil.copytree(SHARED, link)


def render_one(name, src, variables, res, four_k, rate, pdir, force=False, log=print):
    out = pdir / "gfx" / str(res) / f"{name}.mov"
    out.parent.mkdir(parents=True, exist_ok=True)
    if variables:
        known = declared_vars(src)
        extra = sorted(set(variables) - known) if known else []
        if extra:
            log(f"  gfx {name}: ignoring undeclared variable(s) {', '.join(extra)}")
            variables = {k: v for k, v in variables.items() if k in known} or None
    ident = [variables, res, HF] if rate.ntsc else [variables, res, HF, rate.ff]
    key = files_hash(src, SHARED, extra=json.dumps(ident, ensure_ascii=False), skip=unused_kits(src))
    kfile = out.with_suffix(".key")
    if not force and out.exists() and kfile.exists() and kfile.read_text(encoding="utf-8") == key:
        return name, res, "cached"
    with tempfile.TemporaryDirectory(prefix=f"gfx_{name}_") as tmp:
        work = Path(tmp) / "p"
        shutil.copytree(src, work, ignore=shutil.ignore_patterns(*SKIP), symlinks=False)
        link_shared(work / "shared")
        raw = Path(tmp) / "raw.mov"
        cmd = tools.hyperframes(HF) + ["render", ".", "--format", "mov", "--fps", "24" if rate.ntsc else rate.ff,
               "-o", str(raw), "--quiet", "--workers", str(resources.hf_workers())]
        if res == 2160:
            cmd += ["--resolution", four_k]
        if variables:
            cmd += ["--variables", json.dumps(variables, ensure_ascii=False), "--strict-variables"]
        env = dict(os.environ, PRODUCER_BROWSER_GPU_MODE="hardware")
        with resources.gpu_slot():                  # the render captures frames with the GPU
            r = subprocess.run(cmd, cwd=work, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", env=env, stdin=subprocess.DEVNULL)
        if r.returncode != 0 or not raw.exists():
            raise RuntimeError(f"render {name}@{res} failed:\n{r.stdout[-1500:]}\n{r.stderr[-1500:]}")
        tmp_out = out.with_suffix(".tmp.mov")
        if rate.ntsc:
            mid = Path(tmp) / "mid.mov"
            subprocess.run([tools.ffmpeg(), "-v", "error", "-y", "-i", str(raw), "-c", "copy", "-video_track_timescale",
                            "24000", str(mid)], check=True)
            subprocess.run([tools.ffmpeg(), "-v", "error", "-y", "-i", str(mid), "-c", "copy", "-bsf:v",
                            "setts=pts=N*1001:dts=N*1001:duration=1001", "-video_track_timescale", "24000",
                            str(tmp_out)], check=True)
        else:
            shutil.move(raw, tmp_out)
        os.replace(tmp_out, out)
    kfile.write_text(key, encoding="utf-8")
    return name, res, "rendered"


def render_all(tl, pdir, resolutions, force=False, jobs=None, log=print):
    todo = jobs_for(tl, pdir, resolutions)
    missing = [j for j in todo if not (j[1] / "index.html").exists()]
    if missing:
        raise FileNotFoundError(f"graphics without a composition: {sorted({m[0] for m in missing})}")
    done = {"cached": 0, "rendered": 0}
    with ThreadPoolExecutor(jobs or resources.hf_jobs()) as ex:
        futs = [ex.submit(render_one, *j, pdir, force) for j in todo]
        for f in futs:
            name, res, how = f.result()
            done[how] += 1
            if how == "rendered":
                log(f"  gfx {name}@{res} rendered")
    log(f"graphics: {done['rendered']} rendered, {done['cached']} cached")


def link_media(src, dst):
    """Make `dst` show the file `src` without copying it: a symbolic link where the system allows
    it, else a hard link, else a copy.  Returns "symlink", "hardlink" or "copy"."""
    src, dst = Path(src), Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        dst.symlink_to(os.path.abspath(src))
        return "symlink"
    except (OSError, NotImplementedError):
        pass
    try:
        os.link(src, dst)
        return "hardlink"
    except OSError:
        pass
    if dst.is_symlink() or dst.exists():
        dst.unlink()
    shutil.copy2(src, dst)
    return "copy"
