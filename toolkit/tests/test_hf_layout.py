"""A synced b-roll with a composed layout (a phone or tablet screen next to the host in a circle) in the HyperFrames
project: the structure of the written files, and, where HyperFrames runs, a numeric comparison of a project snapshot
with the frame the toolkit's own ffmpeg build (render.frame_cmd on the conformed copy) composes at the same time."""
import json
import re
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path

import common
from vekit import broll, hfproject, render, tools
from vekit.model import Clip, Timeline

FPS = "25"
# the host in a square window of its 16:9 file, the screen in a box on the left, the host's circle on the right
LAYOUT = {"box": [0.04, 0.2, 0.5, 0.6], "radius": 0.02, "bg": "bg.png",
          "pip": {"file": "Main.mp4", "offset": 0.0, "crop": [0.21875, 0.0, 0.78125, 1.0], "box": [0.6, 0.2, 0.36, 0.6]}}


def lavfi(path, source, seconds, fps=FPS, audio=False):
    args = [tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", f"{source}:r={fps}:d={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=f=300:d={seconds}:r=48000", "-shortest", "-c:a", "aac"]
    subprocess.run(args + ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)],
                   check=True, stdin=subprocess.DEVNULL)


def make_layout_video(root, layout=None, motion="none", scale=1.0):
    """A video folder with one synced b-roll over two kept A-roll pieces (A-roll 0.48 s + 2.0 s, one second each):
    the host is a colourful test picture, the screen is green, the background is orange.
    Returns (video folder, timeline, project folder, the b-roll asset)."""
    root = Path(root)
    vdir = root / "Video"
    pdir = vdir / "CLAUDE_VE"
    (pdir / "build").mkdir(parents=True)
    lavfi(vdir / "Main.mp4", "testsrc2=s=640x360", 4, audio=True)
    lavfi(vdir / "Screen.mp4", "color=c=0x20c040:s=320x180", 4)
    subprocess.run([tools.ffmpeg(), "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xe08020:s=1920x1080:d=1",
                    "-frames:v", "1", str(vdir / "bg.png")], check=True, stdin=subprocess.DEVNULL)
    tl = Timeline(width=1920, height=1080, fps=FPS, base=vdir)
    n = tl.rate.s2f
    tl.assets["aroll:a1"] = {"kind": "aroll", "file": "Main.mp4", "fcp_file": "Main.mp4", "tc_start": 0,
                             "audio": "CLAUDE_VE/audio/a1_48k.wav", "frames": n(4), "w": 640, "h": 360}
    tl.spine = [Clip("aroll:a1", n(1), src=n(0.48), name="A-roll"), Clip("aroll:a1", n(1), src=n(2.0), name="A-roll")]
    lay = dict(LAYOUT if layout is None else layout)
    asset = {"kind": "broll", "name": "tablet", "file": "CLAUDE_VE/broll/mezz/tablet.mov", "frames": n(2), "alpha": False,
             "src_file": "Screen.mp4", "ranges": [[0.48, n(1)], [2.0, n(1)]], "motion": motion, "slot": n(2),
             "layout": lay, "fps": tl.rate.ff, "codec": "prores"}
    tl.assets["broll:tablet"] = asset
    tl.connected.append(Clip("broll:tablet", n(2), src=0, rec=0, lane=1, audio=False, name="tablet", scale=scale))
    tl.save(pdir / "build" / "timeline.json")
    (pdir / "project.json").write_text(json.dumps({"voice_gain_db": 0.0}), encoding="utf-8")
    (pdir / "hits.json").write_text("{}", encoding="utf-8")
    return vdir, tl, pdir, asset


def have_hyperframes():
    if not common.have_ffmpeg():
        return False
    r = subprocess.run(tools.hyperframes() + ["--version"], capture_output=True, text=True, stdin=subprocess.DEVNULL)
    return r.returncode == 0 and "0." in r.stdout


def rgb_grid(path, w=160, h=90):
    """The picture as rows of (r, g, b), scaled to w by h."""
    raw = subprocess.run([tools.ffmpeg(), "-v", "error", "-i", str(path), "-vf", f"scale={w}:{h}:flags=area",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True,
                         stdin=subprocess.DEVNULL).stdout
    return [[tuple(raw[(y * w + x) * 3:(y * w + x) * 3 + 3]) for x in range(w)] for y in range(h)]


def rgb_grid_yuv(path, size, w=160, h=90):
    """The same for a raw yuv422p10le frame of the build (BT.709, limited range, as the toolkit tags its video)."""
    raw = subprocess.run([tools.ffmpeg(), "-v", "error", "-f", "rawvideo", "-pix_fmt", "yuv422p10le", "-s", size,
                          "-i", str(path), "-vf", f"scale={w}:{h}:flags=area:in_color_matrix=bt709:in_range=tv,format=rgb24",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True,
                         stdin=subprocess.DEVNULL).stdout
    return [[tuple(raw[(y * w + x) * 3:(y * w + x) * 3 + 3]) for x in range(w)] for y in range(h)]


def mean_diff(a, b, area=None):
    """Mean absolute difference per channel, 0 to 1, over `area` = (x0, y0, x1, y1) in fractions or everything."""
    h, w = len(a), len(a[0])
    x0, y0, x1, y1 = area or (0, 0, 1, 1)
    total = count = 0
    for y in range(int(y0 * h), int(y1 * h)):
        for x in range(int(x0 * w), int(x1 * w)):
            total += sum(abs(p - q) for p, q in zip(a[y][x], b[y][x]))
            count += 3
    return total / count / 255


def near(color, target, tol=40):
    return all(abs(c - t) <= tol for c, t in zip(color, target))


class LayoutStructureTest(common.Case):
    def export(self, **kw):
        vdir, tl, pdir, asset = make_layout_video(self.tmp, **kw)
        self.log = []
        out = hfproject.export(vdir, log=self.log.append)
        parser = hfproject._Index()
        parser.feed((out / "index.html").read_text(encoding="utf-8"))
        self.clips = {a["id"]: (tag, a) for tag, a in parser.clips}
        return vdir, out

    def comp(self, out, cid):
        return (out / "compositions" / f"{cid}.html").read_text(encoding="utf-8")

    def videos(self, text):
        return {a["id"]: a for a in (dict(re.findall(r'([\w-]+)="([^"]*)"', m)) for m in re.findall(r"<video\b([^>]*)>", text))}

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_every_piece_is_a_host_on_track_one_that_passes_the_self_check_without_a_warning(self):
        vdir, out = self.export()
        self.assertEqual(hfproject.check_project(out), [])
        self.assertFalse([w for w in self.log if w.startswith("WARN")], self.log)
        hosts = sorted(i for i, (tag, a) in self.clips.items() if a["data-vidai-kind"] == "broll")
        self.assertEqual(hosts, ["b-1", "b-2"])
        for i, start in (("b-1", "0"), ("b-2", "1")):
            tag, a = self.clips[i]
            self.assertEqual((tag, a["data-track-index"], a["data-start"], a["data-duration"]), ("div", "1", start, "1"))
            self.assertEqual(a["data-composition-src"], f"compositions/{i}.html")
            self.assertIn("z-index:1", a["style"])
        # the A-roll keeps the sound and stays under the hosts on track 0
        aroll = [a for _, a in self.clips.values() if a["data-vidai-kind"] == "aroll"]
        self.assertEqual([a["data-has-audio"] for a in aroll], ["true", "true"])
        self.assertEqual([a["data-track-index"] for a in aroll], ["0", "0"])

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_a_layout_file_holds_the_background_the_screen_and_the_host_in_a_circle(self):
        vdir, out = self.export()
        for cid, screen_at, host_at in (("b-1", "0.48", "0.48"), ("b-2", "2", "2")):
            text = self.comp(out, cid)
            self.assertIn(f'<img id="{cid}-bg" src="assets/layout/bg.png"', text)
            self.assertTrue((out / "assets" / "layout" / "bg.png").exists())
            v = self.videos(text)
            self.assertEqual(sorted(v), [f"{cid}-host", f"{cid}-screen"])
            screen, host = v[f"{cid}-screen"], v[f"{cid}-host"]
            self.assertEqual((screen["src"], screen["data-media-start"]), ("assets/media/Screen.mp4", screen_at))
            self.assertEqual((host["src"], host["data-media-start"]), ("assets/media/Main.mp4", host_at))
            for x in (screen, host):                      # muted: only the A-roll clip carries the sound
                self.assertEqual(x["data-start"], "0")
                self.assertGreaterEqual(Fraction(x["data-duration"]), 1)
            self.assertIn("clip-path:inset(", screen["style"])                 # the screen's rounded corners
            self.assertRegex(text, rf"#{cid}-pip \{{[^}}]*border-radius: 50%")
            self.assertRegex(text, rf'<div id="{cid}-pip" style="left:[\d.]+px;top:[\d.]+px;width:[\d.]+px;height:[\d.]+px">')
            self.assertEqual(len(re.findall(r"<video\b[^>]*\bmuted\b", text)), 2)
        # the circle is square: 0.36 of the width is wider than 0.6 of the height, so the height decides (648 px)
        self.assertIn("left:", self.comp(out, "b-1"))
        self.assertRegex(self.comp(out, "b-1"), r'width:648px;height:648px')
        edit = json.loads((out / "edit.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(g["id"] for g in edit["graphics"]), ["b-1", "b-2"])
        self.assertEqual({s["path"] for s in edit["sources"]}, {"assets/media/Main.mp4", "assets/media/Screen.mp4"})

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_the_host_circle_shows_the_cropped_file_stretched_over_the_circle_like_the_build(self):
        vdir, out = self.export()
        v = self.videos(self.comp(out, "b-1"))["b-1-host"]
        # crop [0.21875 .. 0.78125] of 640 px is 360 px wide: the element is 648 / 0.5625 = 1152 px wide, shifted left
        self.assertIn("width:1152px;height:648px", v["style"])
        self.assertIn("left:-252px;top:0px", v["style"])
        self.assertIn("object-fit:fill", v["style"])

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_without_a_background_the_layout_is_on_black_and_without_a_pip_there_is_no_circle(self):
        vdir, out = self.export(layout={"box": [0.1, 0.1, 0.8, 0.8]})
        text = self.comp(out, "b-1")
        self.assertIn("background: #000", text)
        self.assertNotIn("-bg", text)
        self.assertNotIn("-pip", text)
        self.assertEqual(sorted(self.videos(text)), ["b-1-screen"])
        self.assertEqual(hfproject.check_project(out), [])

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_a_crop_only_layout_stays_a_plain_clip(self):
        vdir, out = self.export(layout={"crop": [0.0, 0.0, 0.5, 1.0]})
        self.assertEqual(self.clips["b-1"][0], "video")
        self.assertFalse((out / "compositions" / "b-1.html").exists())

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_motion_zooms_the_whole_composed_picture(self):
        vdir, out = self.export(motion="push")
        text = self.comp(out, "b-1")
        m = re.search(r"data-vidai-layout-motion='(\{[^']*\})'", text)
        self.assertTrue(m, text)
        spec = json.loads(m.group(1))
        self.assertGreater(spec["scale"][1], spec["scale"][0])
        self.assertIn('tl.fromTo("#b-1-zoom"', text)
        # the motion wraps the layers, and the server's B-roll motion shape (b-1-video / b-1-motion) is not used
        self.assertNotIn("b-1-video", text)
        self.assertNotIn("data-vidai-motion", text)
        self.assertLess(text.index('id="b-1-zoom"'), text.index('id="b-1-bg"'))
        self.assertEqual(hfproject.check_project(out), [])

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_the_clips_own_transform_moves_the_whole_layout(self):
        vdir, out = self.export(scale=1.1)
        self.assertIn("scale(1.1)", self.clips["b-1"][1]["style"])
        self.assertNotIn("scale(", self.videos(self.comp(out, "b-1"))["b-1-screen"].get("style", ""))

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_a_missing_background_is_a_plain_sentence(self):
        vdir, tl, pdir, asset = make_layout_video(self.tmp)
        (vdir / "bg.png").unlink()
        with self.assertRaises(hfproject.ExportError) as e:
            hfproject.export(vdir, log=lambda _: None)
        self.assertIn("background picture", str(e.exception))

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_a_host_that_plays_past_its_file_breaks_rule_7(self):
        vdir, out = self.export()
        path = out / "compositions" / "b-1.html"
        path.write_text(path.read_text(encoding="utf-8").replace('data-media-start="0.48"', 'data-media-start="9"'), encoding="utf-8")
        self.assertTrue([p for p in hfproject.check_project(out) if p.startswith("Rule 7")])


class LayoutAgainstTheBuildTest(common.Case):
    """The project's picture at a layout time against the frame of the toolkit's own composition."""

    def reference(self, vdir, tl, pdir, asset, at):
        broll.render_one(asset, vdir, tl.width, tl.height)
        for s, b, base, layers in render.shots_of(tl):
            if s <= at < b:
                out = pdir / "ref.yuv"
                cmd = render.shot_cmd(tl, pdir, 720, at, at + 1, base, layers, out,
                                      encode=["-c:v", "rawvideo", "-pix_fmt", "yuv422p10le", "-f", "rawvideo"])
                subprocess.run(cmd, check=True, capture_output=True, stdin=subprocess.DEVNULL)
                return rgb_grid_yuv(out, "1280x720")
        self.fail("no shot")

    def snapshot(self, project, seconds):
        dest = self.tmp / "snap"
        r = subprocess.run(tools.hyperframes() + ["snapshot", str(project), "--at", str(seconds), "--no-end",
                                                  "-o", str(dest), "--json"],
                           capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=300)
        self.assertEqual(r.returncode, 0, (r.stdout + r.stderr)[-1500:])
        pngs = sorted(dest.glob("*.png"))
        self.assertTrue(pngs, r.stdout[-800:])
        return pngs[0]

    @common.unittest.skipUnless(have_hyperframes(), "needs ffmpeg and the pinned HyperFrames")
    def test_a_snapshot_matches_the_build_at_a_layout_time(self):
        vdir, tl, pdir, asset = make_layout_video(self.tmp)
        project = hfproject.export(vdir, log=lambda _: None)
        at = 13                                                                  # frame 13 (0.52 s) of the edit, sampled a quarter frame in
        ref = self.reference(vdir, tl, pdir, asset, at)
        snap = rgb_grid(self.snapshot(project, (at + 0.25) / 25))
        # the three layers are where the layout says (checked in the project's snapshot)
        self.assertTrue(near(snap[3][3], (0xe0, 0x80, 0x20)), snap[3][3])          # background in the corner
        self.assertTrue(near(snap[45][25], (0x20, 0xc0, 0x40), 50), snap[45][25])  # screen in its box
        self.assertFalse(near(snap[45][124], (0xe0, 0x80, 0x20), 40))              # host in the circle
        self.assertTrue(near(snap[20][99], (0xe0, 0x80, 0x20), 40))               # circle corner shows background
        self.assertTrue(near(ref[20][99], (0xe0, 0x80, 0x20), 40))
        self.assertFalse(near(ref[45][124], (0xe0, 0x80, 0x20), 40))
        self.assertLess(mean_diff(snap, ref), 0.03)
        self.assertLess(mean_diff(snap, ref, (0.6, 0.2, 0.96, 0.8)), 0.06)         # the host's circle
        self.assertLess(mean_diff(snap, ref, (0.04, 0.2, 0.54, 0.8)), 0.03)        # the screen box
        # and the second piece (the A-roll's other cut)
        at2 = 25 + 13
        ref2 = self.reference(vdir, tl, pdir, asset, at2)
        snap2 = rgb_grid(self.snapshot(project, (at2 + 0.25) / 25))
        self.assertLess(mean_diff(snap2, ref2), 0.03)
