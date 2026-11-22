"""`ve.py graphic`: the six full-screen templates, their variables, the files the command writes, and (when
HyperFrames and its browser are installed) a real render of every template in both orientations."""
import json
import os
import re
import struct
import subprocess
import sys
import unittest
import zlib
from pathlib import Path

import common
from vekit import gfx, graphic, hfproject
from vekit.model import Rate

VE = common.KIT / "ve.py"
TEMPLATE_NAMES = ["compare", "image", "list", "quote", "stat", "title"]
MIXED = "iPhone 17 Pro में सबसे बड़ा upgrade कौन सा है और क्यों"
VARS = {
    "title": {"title": MIXED, "kicker": "Chapter 3", "subtitle": "Qi2 और MagSafe का फ़र्क"},
    "stat": {"value": "₹1,00,000+", "label": "Happy customers - हमारे ग्राहक", "note": "Source: survey"},
    "list": {"items": "तेज़ processor|120Hz display|5000mAh battery", "title": "तीन बातें", "style": "checks"},
    "quote": {"quote": "सबसे अच्छा camera वही है जो आपके पास रहता है.", "author": "A. Name", "role": "Reviewer"},
    "compare": {"a_label": "Qi2", "b_label": "MagSafe पुराना", "a_items": "15W|Magnet ring", "b_items": "7.5W|Bulky case",
                "title": "कौन सा बेहतर?"},
    "image": {"caption": "Pixel 9 Pro - सबसे अच्छा camera", "kicker": "NEW", "image": "photo src.png"},
}


def hyperframes_mjs():
    """The pinned HyperFrames CLI of this checkout when it and its browser are installed, else None."""
    mjs = os.environ.get("VE_TEST_HYPERFRAMES") or str(common.TOOLKIT.parent / "node_modules" / "hyperframes" / "bin" / "hyperframes.mjs")
    chrome = Path(os.path.expanduser("~/.cache/hyperframes/chrome"))
    if Path(mjs).is_file() and chrome.is_dir() and any(chrome.iterdir()) and common.have_ffmpeg():
        return mjs
    return None


def make_video(root, width, height):
    video = root / f"video-{width}"
    (video / "CLAUDE_VE").mkdir(parents=True)
    (video / "CLAUDE_VE" / "project.json").write_text(json.dumps({"width": width, "height": height}), encoding="utf-8")
    (video / "photo src.png").write_bytes(tiny_png(64, 40))
    return video


def tiny_png(w, h):
    """A small gradient PNG written without any imaging library."""
    rows = b"".join(b"\x00" + bytes(c for x in range(w) for c in (x * 4 % 256, y * 6 % 256, 160)) for y in range(h))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def run_ve(*args, cwd=None):
    return subprocess.run([sys.executable, str(VE), "graphic", *map(str, args)], capture_output=True, text=True,
                          encoding="utf-8", env=common.clean_env(PYTHONDONTWRITEBYTECODE="1"), stdin=subprocess.DEVNULL,
                          timeout=120, cwd=cwd)


def var_args(name):
    return [f"{k}={v}" for k, v in VARS[name].items()]


class GraphicCommandTest(common.Case):
    def setUp(self):
        super().setUp()
        self.land = make_video(self.tmp, 1920, 1080)
        self.port = make_video(self.tmp, 1080, 1920)

    def gfx_dir(self, video, name):
        return video / "CLAUDE_VE" / "gfx_src" / name

    def test_list_names_every_template_with_its_variables_one_line_each(self):
        r = run_ve("--list")
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.strip().splitlines()
        self.assertEqual([ln.split(" - ")[0] for ln in lines[:-1]], TEMPLATE_NAMES)
        self.assertIn("title*", lines[5])
        self.assertIn("accent=#FFB400", lines[-1])
        self.assertIn("items*", lines[2])

    def test_every_template_is_complete_and_the_icon_names_match_the_page_kit(self):
        known = graphic.templates()
        self.assertEqual(sorted(known), TEMPLATE_NAMES)
        for name, meta in known.items():
            html = (meta["folder"] / "index.html").read_text(encoding="utf-8")
            for token in ("/*@KIT_CSS*/", "/*@KIT_JS*/", "@DECLARED@", "@DEFAULTS@", "@DURATION@", 'data-composition-id="main"',
                          '__timelines["main"]'):
                self.assertIn(token, html, f"{name}: {token}")
            ids = [v["id"] for v in meta["variables"]]
            self.assertEqual(len(ids), len(set(ids)), name)
            for tag in ("accent", "accent2", "bg1", "bg2", "text", "font", "seed"):
                self.assertIn(tag, ids)
        kit_js = (graphic.KIT_DIR / "kit.js").read_text(encoding="utf-8")
        icons = re.search(r"const ICONS = \{(.*?)\n  \};", kit_js, re.S).group(1)
        self.assertEqual(tuple(re.findall(r"^    (\w+):", icons, re.M)), graphic.ICONS)

    def test_no_em_dash_in_the_new_files(self):
        files = list(graphic.TEMPLATES.glob("graphic_*/*")) + list(graphic.KIT_DIR.glob("*")) + [Path(graphic.__file__)]
        for f in files:
            self.assertNotIn("\u2014", f.read_text(encoding="utf-8"), str(f))

    def test_each_template_writes_a_page_for_the_orientation_and_records_its_variables(self):
        for video, size in ((self.land, (1920, 1080)), (self.port, (1080, 1920))):
            for name in TEMPLATE_NAMES:
                r = run_ve(video, f"g-{name}", "--template", name, "--var", *var_args(name))
                self.assertEqual(r.returncode, 0, name + r.stderr[-400:])
                self.assertIn(f"G:g-{name}", r.stdout)
                d = self.gfx_dir(video, f"g-{name}")
                page = (d / "index.html").read_text(encoding="utf-8")
                self.assertIn(f'data-width="{size[0]}" data-height="{size[1]}"', page)
                self.assertNotIn("@IMAGE@", page)
                self.assertNotRegex(page, r"@(W|H|DURATION|RES|DECLARED|DEFAULTS)@")
                rec = json.loads((d / "graphic.json").read_text(encoding="utf-8"))
                self.assertEqual(rec["template"], "graphic_" + name)
                for k, v in VARS[name].items():
                    if k != "image":
                        self.assertEqual(rec["variables"][k], v)
                # the declared defaults are the values: what gfx.py, hfproject.py and the page itself read
                self.assertEqual(gfx.declared_vars(d), set(rec["variables"]))
                self.assertEqual(hfproject.declared_defaults(page), rec["variables"])
                self.assertEqual(hfproject.sub_composition(page, "g1", None, "assets/gfx/g1/", warn=self.fail)[1], None)
                self.assertEqual(rec["duration"], float(re.search(r'data-duration="([\d.]+)"', page).group(1)))
        self.assertEqual(sorted(p.name for p in self.gfx_dir(self.port, "g-image").iterdir()), ["graphic.json", "index.html", "photo.png"])
        rec = json.loads((self.gfx_dir(self.port, "g-image") / "graphic.json").read_text(encoding="utf-8"))
        self.assertEqual(rec["variables"]["image"], "photo.png")
        self.assertIn('src="photo.png"', (self.gfx_dir(self.port, "g-image") / "index.html").read_text(encoding="utf-8"))
        self.assertEqual(sorted(p.name for p in self.gfx_dir(self.port, "g-title").iterdir()), ["graphic.json", "index.html"])

    def test_the_page_is_sized_by_the_project_and_the_duration_by_the_template_or_the_option(self):
        run_ve(self.land, "a", "--template", "list", "--var", "items=a|b|c|d")
        self.assertEqual(json.loads((self.gfx_dir(self.land, "a") / "graphic.json").read_text())["duration"], 6.2)
        run_ve(self.land, "a", "--template", "list", "--var", "items=a|b", "--duration", "3.5")
        rec = json.loads((self.gfx_dir(self.land, "a") / "graphic.json").read_text())
        self.assertEqual((rec["duration"], rec["width"]), (3.5, 1920))
        from vekit.plan import gfx_duration_frames
        self.assertEqual(gfx_duration_frames(self.gfx_dir(self.land, "a"), Rate(24)), 84)

    def test_quotes_and_markup_in_values_stay_text(self):
        evil = "It's </script><b>&amp; \"q\" @W@"
        r = run_ve(self.land, "q", "--template", "title", "--var", f"title={evil}")
        self.assertEqual(r.returncode, 0, r.stderr)
        d = self.gfx_dir(self.land, "q")
        page = (d / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("</script><b>", page)
        self.assertEqual(hfproject.declared_defaults(page)["title"], evil)
        self.assertEqual(gfx.declared_vars(d), set(json.loads((d / "graphic.json").read_text())["variables"]))

    def test_bad_input_is_refused_in_one_line_and_writes_nothing(self):
        cases = [
            (["a", "--template", "nope", "--var", "title=x"], "--template must be one of"),
            (["a", "--var", "title=x"], "--template is required"),
            (["a", "--template", "title"], "title is required"),
            (["a", "--template", "title", "--var", "title="], "title is required and must not be empty"),
            (["a", "--template", "title", "--var", "title=x", "accent=red"], "accent must be a colour"),
            (["a", "--template", "title", "--var", "title=x", "font=Bad;Font"], "font must be a font family"),
            (["a", "--template", "title", "--var", "title=x", "align=right"], "align must be one of"),
            (["a", "--template", "title", "--var", "title=x", "bogus=1"], "'bogus' is not a variable"),
            (["a", "--template", "title", "--var", "title=x", "world"], "'world' is not key=value"),
            (["a", "--template", "title", "--var", "title=" + "x" * 500], "at most 120"),
            (["a", "--template", "title", "--var", "title=x", "seed=0"], "seed must be a whole number"),
            (["a", "--template", "list", "--var", "items=only one"], "needs 2 to 6 items"),
            (["a", "--template", "list", "--var", "items=1|2|3|4|5|6|7"], "needs 2 to 6 items"),
            (["a", "--template", "compare", "--var", "a_label=A", "b_label=B", "a_items=1", "b_items="], "b_items needs 1 to 5"),
            (["a", "--template", "stat", "--var", "value=5"], "label is required"),
            (["a", "--template", "image", "--var", "caption=c", "image=missing.png"], "image file not found"),
            (["a", "--template", "image", "--var", "caption=c", "image=notes.txt"], "png, jpg or webp"),
            (["a", "--template", "image", "--var", "caption=c", "icon=sparkle"], "icon must be one of"),
            (["a", "--template", "title", "--var", "title=x", "--duration", "1"], "--duration must be from 2 to 30"),
            (["a", "--template", "title", "--var", "title=x", "--duration", "abc"], "--duration must be a number"),
            (["Bad Name", "--template", "title", "--var", "title=x"], "graphic name must be"),
            (["hit_one", "--template", "title", "--var", "title=x"], "is reserved"),
            (["end_fade", "--template", "title", "--var", "title=x"], "is reserved"),
        ]
        for args, message in cases:
            r = run_ve(self.land, *args)
            self.assertEqual(r.returncode, 1, args)
            err = r.stderr.strip()
            self.assertEqual(len(err.splitlines()), 1, err)
            self.assertIn(message, err, args)
            self.assertNotIn("Traceback", err)
        self.assertFalse((self.land / "CLAUDE_VE" / "gfx_src").exists() and any((self.land / "CLAUDE_VE" / "gfx_src").iterdir()))

    def test_a_video_without_project_json_needs_an_orientation(self):
        bare = self.tmp / "bare"
        bare.mkdir()
        r = run_ve(bare, "a", "--template", "title", "--var", "title=T")
        self.assertIn("run `ve.py prep` first", r.stderr)
        r = run_ve(bare, "a", "--template", "title", "--var", "title=T", "--orientation", "portrait")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('data-width="1080" data-height="1920"', (bare / "CLAUDE_VE" / "gfx_src" / "a" / "index.html").read_text(encoding="utf-8"))
        r = run_ve(self.tmp / "nowhere", "a", "--template", "title", "--var", "title=T")
        self.assertIn("does not exist", r.stderr)

    def test_writing_again_replaces_the_graphic_and_leaves_nothing_behind(self):
        run_ve(self.land, "again", "--template", "image", "--var", "caption=c", "image=photo src.png")
        run_ve(self.land, "again", "--template", "title", "--var", "title=Second")
        d = self.gfx_dir(self.land, "again")
        self.assertEqual(sorted(p.name for p in d.iterdir()), ["graphic.json", "index.html"])
        self.assertEqual(sorted(p.name for p in d.parent.iterdir()), ["again"])
        self.assertEqual(json.loads((d / "graphic.json").read_text())["variables"]["title"], "Second")

    def test_a_planned_timeline_finds_the_graphic(self):
        run_ve(self.land, "intro", "--template", "title", "--var", "title=T")
        from vekit.plan import gfx_duration_frames
        self.assertEqual(gfx_duration_frames(self.gfx_dir(self.land, "intro"), Rate(24)), 108)


@unittest.skipUnless(hyperframes_mjs(), "needs HyperFrames and its browser (node_modules/hyperframes, ~/.cache/hyperframes/chrome)")
class GraphicRenderTest(common.Case):
    """Each template through the same render path `ve.py gfx` uses: opaque, never flat, moving to the last frame."""

    def pixels(self, mov, seconds, *args):
        return subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{seconds:.3f}", "-i", str(mov), "-frames:v", "1", *args,
                               "-f", "rawvideo", "-"], capture_output=True).stdout

    def small(self, mov, seconds, size):
        """The frame as 8-bit RGB values at one eighth of its size."""
        return self.pixels(mov, seconds, "-vf", f"scale={size[0] // 8}:{size[1] // 8}", "-pix_fmt", "rgb24")

    @staticmethod
    def spread(values):
        mean = sum(values) / len(values)
        return (sum((v - mean) ** 2 for v in values) / len(values)) ** 0.5

    @staticmethod
    def distance(a, b):
        return sum(abs(x - y) for x, y in zip(a, b)) / len(a)

    def check(self, video, tpl, size):
        self.env(VE_HYPERFRAMES=hyperframes_mjs())
        name = f"g-{tpl}"
        r = run_ve(video, name, "--template", tpl, "--var", *var_args(tpl), "--duration", "2.5")
        self.assertEqual(r.returncode, 0, r.stderr)
        pdir = video / "CLAUDE_VE"
        res = gfx.render_one(name, pdir / "gfx_src" / name, None, 720, "portrait-4k" if size[1] > size[0] else "landscape-4k",
                             Rate(24), pdir, force=True)
        self.assertEqual(res[2], "rendered")
        mov = pdir / "gfx" / "720" / f"{name}.mov"
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height",
                              "-of", "csv=p=0", str(mov)], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, f"{size[0]},{size[1]}")
        frames = [self.small(mov, t, size) for t in (0.1, 1.25, 2.38)]
        for t in (0.1, 1.25, 2.38):
            alpha = self.pixels(mov, t, "-vf", "alphaextract", "-pix_fmt", "gray")
            self.assertEqual(len(alpha), size[0] * size[1], name)
            self.assertEqual(min(alpha), 255, f"{name}: a transparent pixel at {t}s")
        for f in frames:
            self.assertGreater(self.spread(f), 10.0, f"{name}: a flat frame")
        self.assertGreater(self.distance(frames[0], frames[1]), 2.0, f"{name}: start and middle look alike")
        self.assertGreater(self.distance(frames[1], frames[2]), 0.5, f"{name}: middle and end look alike")
        self.assertGreater(self.distance(self.small(mov, 2.25, size), self.small(mov, 2.42, size)), 0.05,
                           f"{name}: standing still at the end")

    def test_every_template_renders_in_both_orientations(self):
        for size in ((1920, 1080), (1080, 1920)):
            video = make_video(self.tmp, *size)
            for tpl in TEMPLATE_NAMES:
                with self.subTest(template=tpl, size=size):
                    self.check(video, tpl, size)


if __name__ == "__main__":
    unittest.main()
