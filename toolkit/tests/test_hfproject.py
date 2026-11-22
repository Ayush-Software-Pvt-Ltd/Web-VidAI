"""`ve.py hf`: the HyperFrames project of an edit (vekit/hfproject.py, SPEC section 10)."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from fractions import Fraction
from pathlib import Path

import common  # noqa: F401  (puts the toolkit on sys.path)
from vekit import hfproject
from vekit.model import Clip, Timeline
from vekit.paths import KIT, rel

VE = KIT / "ve.py"
SERVER_ROOT_SCRIPT = Path(__file__).resolve().parents[2] / "server" / "src" / "timeline" / "rootScript.js"
SERVER_FIXTURES = Path(__file__).resolve().parents[2] / "server" / "test" / "support" / "fixtures"

GFX = """<!doctype html>
<html lang="en" data-composition-variables='[{"id":"text","type":"string","default":"x"}]'>
  <head>
    <script src="shared/js/gsap.min.js"></script>
    <style>
      html, body { width: %(w)spx; height: %(h)spx; background: transparent; }
      #root { position: relative; width: 100%%; height: 100%%; }
      #card { position: absolute; left: 10%%; top: 10%%; width: 80%%; height: 20%%; background: #e33; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="%(w)s" data-height="%(h)s">
      <div id="card"></div>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      const v = (window.__hyperframes && window.__hyperframes.getVariables) ? window.__hyperframes.getVariables() : {};
      document.getElementById("card").title = v.text || "";
      tl.fromTo("#card", { opacity: 0 }, { opacity: 1, duration: 0.2 }, 0);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
"""


def make_video(root, fps="30000/1001", landscape=True, motion="push"):
    """A small video folder with a hand-made build/timeline.json that uses every kind of element:
    A-roll cuts with a punch-in, a b-roll (cropped for a vertical edit), a synced b-roll in a box,
    an overlay graphic of the video, a keyword hit, the end fade and two sound effects."""
    root = Path(root)
    vdir = root / "Video one"
    pdir = vdir / "CLAUDE_VE"
    (pdir / "build").mkdir(parents=True)
    (pdir / "gfx_src" / "lower").mkdir(parents=True)
    size = "320x180" if landscape else "180x320"
    common.make_clip(vdir / "Main.mp4", size=size, seconds=7, fps=fps)
    common.make_clip(vdir / "B-roll 1.mp4", size="320x180", seconds=4, fps=25, audio=False)
    common.make_clip(vdir / "Screen.mp4", size="320x180", seconds=4, fps=25, audio=False)
    rate = Timeline(fps=fps).rate
    n = lambda s: rate.s2f(s)  # noqa: E731
    W, H = (3840, 2160) if landscape else (2160, 3840)
    fw, fh = (1920, 1080) if landscape else (1080, 1920)
    tl = Timeline(width=W, height=H, fps=fps, base=vdir)
    tl.assets["aroll:a1"] = {"kind": "aroll", "file": "Main.mp4", "fcp_file": "Main.mp4", "tc_start": 0,
                             "audio": "CLAUDE_VE/audio/a1_48k.wav", "frames": n(6), "w": W, "h": H}
    tl.spine = [Clip("aroll:a1", n(2), src=0, name="A-roll"),
                Clip("aroll:a1", n(2), src=n(2.5), scale=1.18, pos=(0.0, -3.0), name="A-roll"),
                Clip("aroll:a1", n(2), src=n(4), name="A-roll", fade_out=n(0.5))]
    crop = None if landscape else [0.3418, 0.0, 0.6582, 1.0]
    b = {"kind": "broll", "name": "city", "file": "CLAUDE_VE/broll/mezz/x.mov", "frames": 60, "alpha": False,
         "src_file": "B-roll 1.mp4", "src_fps": "25", "src_start": 5, "motion": motion, "slot": n(1)}
    if crop:
        b["crop"] = crop
    tl.assets["broll:city"] = b
    tl.connected.append(Clip("broll:city", n(1), src=7, rec=n(0.5), lane=1, audio=False, name="city"))
    tl.assets["broll:screen"] = {"kind": "broll", "name": "screen", "file": "CLAUDE_VE/broll/mezz/y.mov", "frames": n(1),
                                 "alpha": False, "src_file": "Screen.mp4", "ranges": [[0.5, n(0.5)], [2.0, n(0.5)]],
                                 "motion": "none", "slot": n(1), "layout": {"box": [0.1, 0.1, 0.8, 0.5], "radius": 0.02},
                                 "fps": rate.ff, "codec": "prores"}
    tl.connected.append(Clip("broll:screen", n(1), src=0, rec=n(2.5), lane=1, audio=False, name="screen"))
    (pdir / "gfx_src" / "lower" / "index.html").write_text(GFX % {"w": fw, "h": fh}, encoding="utf-8")
    tl.assets["gfx:lower"] = {"kind": "gfx", "name": "lower", "frames": n(2), "alpha": True}
    tl.connected.append(Clip("gfx:lower", n(1), rec=n(1), lane=2, audio=False, name="lower"))
    tl.assets["gfx:hit_01"] = {"kind": "gfx", "name": "hit_01", "frames": n(6), "alpha": True, "hit": "Free today"}
    tl.connected.append(Clip("gfx:hit_01", n(1), rec=n(4), lane=3, audio=False, name="Free today", pos=(0.0, 2.0)))
    tl.assets["gfx:end_fade"] = {"kind": "gfx", "name": "end_fade", "frames": n(2), "alpha": True}
    tl.connected.append(Clip("gfx:end_fade", n(0.5), rec=n(5.5), lane=4, audio=False, name="Fade to black"))
    manifest = json.loads((KIT / "sfx" / "manifest.json").read_text(encoding="utf-8"))
    for key, at in [("whoosh1", 0.4), ("whoosh2", 2.4), ("pop1", 4.0)]:
        frames = manifest[key]["samples"] // rate.spf
        tl.assets[f"sfx:{key}"] = {"kind": "sfx", "file": rel(KIT / "sfx" / f"{key}.wav", vdir),
                                   "samples": manifest[key]["samples"], "frames": frames}
        tl.connected.append(Clip(f"sfx:{key}", frames, rec=n(at), lane=-1, video=False, volume_db=-12.0, name=key))
    tl.save(pdir / "build" / "timeline.json")
    project = {"voice_gain_db": 0.0}
    if landscape:
        project.update(hit_template="hot_hit_16x9", end_template="end_fade_16x9")
    (pdir / "project.json").write_text(json.dumps(project), encoding="utf-8")
    (pdir / "hits.json").write_text(json.dumps({"hit_01": "Free today"}), encoding="utf-8")
    (pdir / "transcripts").mkdir()
    words = [{"w": w, "s": 0.2 + i * 0.5, "e": 0.5 + i * 0.5, "p": 0.9} for i, w in enumerate("one two three four five six".split())]
    (pdir / "transcripts" / "a1.chunks.json").write_text(
        json.dumps({"chunks": [{"i": 0, "s": 0, "e": 5, "text": "x", "words": words}]}), encoding="utf-8")
    return vdir


class HfProjectTest(common.Case):
    def setUp(self):
        super().setUp()
        self.log = []

    def export(self, **kw):
        vdir = make_video(self.tmp, **kw)
        out = hfproject.export(vdir, log=self.log.append)
        return vdir, out

    def clips(self, out):
        parser = hfproject._Index()
        parser.feed((out / "index.html").read_text(encoding="utf-8"))
        return parser.root, {a["id"]: (tag, a) for tag, a in parser.clips}

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_long_edit_writes_every_element_and_passes_the_self_check(self):
        vdir, out = self.export(fps="30000/1001", landscape=True)
        self.assertEqual(out, vdir / "output" / "Video one.hf")
        self.assertEqual(hfproject.check_project(out), [])
        root, clips = self.clips(out)
        self.assertEqual((root["data-width"], root["data-height"], root["data-fps"]), ("1920", "1080", "30000/1001"))
        kinds = sorted(a["data-vidai-kind"] for _, a in clips.values())
        self.assertEqual(kinds, ["aroll"] * 3 + ["broll"] * 3 + ["fade", "hit", "overlay", "sfx", "sfx", "sfx"])
        for _, a in clips.values():
            self.assertIn("class", a)
        self.assertEqual({a["data-track-index"] for _, a in clips.values() if a["data-vidai-kind"] == "sfx"}, {"10"})
        # the punch-in and the hit's lift are static style, the last A-roll clip's fade is a clip-edge fade
        self.assertIn("scale(1.18)", clips["a-2"][1]["style"])
        self.assertIn("translate(0px,32.4px)", clips["a-2"][1]["style"])
        self.assertIn("translate(0px,-21.6px)", clips["h-1"][1]["style"])
        self.assertEqual(clips["a-3"][1]["data-fade-out"], clips["fade-1"][1]["data-duration"])
        self.assertNotIn("data-automation", clips["a-3"][1])
        self.assertEqual(clips["a-3"][1]["data-has-audio"], "true")
        # the b-roll plays the original at every source frame once (25 fps in a 29.97 edit)
        # the push becomes a host of kind broll whose file holds the video and the zoom
        self.assertEqual(clips["b-1"][0], "div")
        self.assertEqual(clips["b-1"][1]["data-composition-src"], "compositions/b-1.html")
        comp = (out / "compositions" / "b-1.html").read_text(encoding="utf-8")
        self.assertIn('src="assets/media/B-roll_1.mp4"', comp)
        self.assertIn('tl.fromTo("#b-1-motion"', comp)
        self.assertIn("data-vidai-motion='", comp)
        rate = re.search(r'data-playback-rate="([^"]+)"', comp).group(1)
        self.assertAlmostEqual(float(Fraction(rate)), 30000 / 1001 / 25, places=5)
        edit0 = json.loads((out / "edit.json").read_text(encoding="utf-8"))
        self.assertIn("b-1", [g["id"] for g in edit0["graphics"]])
        self.assertIn("assets/media/B-roll_1.mp4", [x["path"] for x in edit0["sources"]])
        self.assertFalse([w for w in self.log if "motion" in w])
        edit = json.loads((out / "edit.json").read_text(encoding="utf-8"))
        self.assertEqual(edit["toolkitVersion"], (KIT.parent / "VERSION").read_text(encoding="utf-8").strip())
        self.assertEqual(sorted(g["id"] for g in edit["graphics"]), ["b-1", "fade-1", "h-1", "ov-1"])
        self.assertEqual([g for g in edit["graphics"] if g["id"] == "h-1"][0]["variables"], {"text": "Free today"})
        self.assertTrue((out / "shared" / "js" / "gsap.min.js").is_file())
        self.assertFalse((out / "shared").is_symlink())
        self.assertTrue((out / "assets" / "media" / "Main.mp4").exists())
        self.assertTrue((out / "assets" / "sfx" / "whoosh1.wav").is_file())
        for name in ("hyperframes.json", "meta.json", "transcript.json"):
            self.assertTrue((out / name).is_file(), name)
        words = json.loads((out / "transcript.json").read_text(encoding="utf-8"))["words"]
        self.assertEqual([w["word"] for w in words][:3], ["one", "two", "three"])

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_short_edit_at_25_fps(self):
        vdir, out = self.export(fps="25", landscape=False)
        self.assertEqual(hfproject.check_project(out), [])
        root, clips = self.clips(out)
        self.assertEqual((root["data-width"], root["data-height"], root["data-fps"]), ("1080", "1920", "25"))
        self.assertIn("clip-path:inset(", (out / "compositions" / "b-1.html").read_text(encoding="utf-8"))
        self.assertEqual(root["data-duration"], "6")

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_a_broll_without_motion_stays_a_plain_clip(self):
        vdir, out = self.export(fps="25", landscape=True, motion="none")
        root, clips = self.clips(out)
        self.assertEqual(clips["b-1"][0], "video")
        self.assertEqual(clips["b-1"][1]["src"], "assets/media/B-roll_1.mp4")
        self.assertFalse((out / "compositions" / "b-1.html").exists())

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_motion_zooms_and_slides_as_the_conformed_copy_did(self):
        def tween(motion):
            vdir, out = self.export(fps="25", landscape=True, motion=motion)
            comp = (out / "compositions" / "b-1.html").read_text(encoding="utf-8")
            m = re.search(r"data-vidai-motion='(\{[^']*\})'", comp)
            self.assertTrue(m, comp)
            spec = json.loads(m.group(1))
            shutil.rmtree(vdir)
            return [spec["scale"][0], spec["x"][0], spec["scale"][1], spec["x"][1], spec["duration"]]
        z0, x0, z1, x1, d = tween("push")                 # frames 7..32 of 60: 1 + 0.12 * on / 60
        self.assertAlmostEqual((z0, z1, d), (1.014, 1.064, 1.0))
        self.assertEqual((x0, x1), (0, 0))
        pull = tween("pull")
        self.assertAlmostEqual(pull[0], 1.106) and self.assertGreater(pull[0], pull[2])
        right, left = tween("right"), tween("left")
        self.assertEqual((right[0], right[2]), (1.08, 1.08))
        self.assertGreater(right[1], right[3])            # the window moves right: the picture slides left
        self.assertLess(left[1], left[3])

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_a_motion_broll_file_has_the_shape_the_server_edits(self):
        """The video's in-point and length and the movement are plain attributes; the inner video lasts as long as the file allows."""
        vdir, out = self.export(fps="25", landscape=True)
        comp = (out / "compositions" / "b-1.html").read_text(encoding="utf-8")
        video = dict(re.findall(r'([\w-]+)="([^"]*)"', re.search(r"<video\b([^>]*)>", comp).group(1)))
        self.assertEqual(video["data-start"], "0")
        self.assertEqual(video["data-media-start"], "0.48")           # frame 12 of the 25 fps file
        self.assertEqual(video["data-duration"], "3.52")              # the rest of the 4 second file
        self.assertIn('const m = JSON.parse(document.getElementById("b-1-motion")', comp)
        self.assertEqual(hfproject.check_project(out), [])

    def test_the_motion_composition_is_the_one_the_servers_fixture_holds(self):
        """The same file byte for byte on both sides (server/test/timeline/editsMotion.test.js reads it too)."""
        fps = Fraction(30)
        broll = hfproject.Source("broll.mp4", "assets/media/broll.mp4", None,
                                 {"fps": Fraction(25), "frames": 1500, "dur": Fraction(60), "audio": False, "w": 1920, "h": 1080}, fps)
        specs = {"b-1": ({"src": broll, "media_start": Fraction(2), "rate": Fraction(1), "style": "", "motion": "push",
                          "from": (1.0, 0.0), "to": (1.1, 0.0)}, 90),
                 "b-2": ({"src": broll, "media_start": Fraction(10), "rate": Fraction(1), "style": "", "motion": "left",
                          "from": (1.08, 76.8), "to": (1.08, -76.8)}, 60)}
        folder = SERVER_FIXTURES / "projects" / "motion" / "compositions"
        if not folder.is_dir():
            self.skipTest("the server's fixtures are not next to the toolkit")
        for cid, (spec, dur) in specs.items():
            text, _ = hfproject.broll_composition(cid, spec, dur, fps, 1920, 1080)
            self.assertEqual(text, (folder / f"{cid}.html").read_text(encoding="utf-8"), cid)

    def test_the_inner_video_never_ends_before_its_host_and_stays_in_the_file(self):
        broll = hfproject.Source("b.mp4", "assets/media/b.mp4", None,
                                 {"fps": Fraction(25), "frames": 250, "dur": Fraction(10), "audio": False, "w": 1, "h": 1}, Fraction(25))
        self.assertEqual(hfproject.inner_frames(broll, Fraction(2), Fraction(1), 50, Fraction(25)), 200)   # the file's rest
        self.assertEqual(hfproject.inner_frames(broll, Fraction(9), Fraction(1), 50, Fraction(25)), 50)    # never below the host
        self.assertEqual(hfproject.inner_frames(broll, Fraction(2), Fraction(1), 50, Fraction(25)), 200)

    def test_the_fade_rule_table_of_the_server(self):
        """server/test/support/fixtures/fade-rule.json is run by lanes.test.js too."""
        table = SERVER_FIXTURES / "fade-rule.json"
        if not table.is_file():
            self.skipTest("the server's fixtures are not next to the toolkit")
        for case in json.loads(table.read_text(encoding="utf-8"))["cases"]:
            clips = [(c["src"], Fraction(str(c["mediaStart"])), Fraction(str(c["rate"])), c["dur"], c["sound"])
                     for c in case["clips"]]
            got = hfproject.fade_plan(clips, Fraction(case["fps"]), case["endFrames"])
            want = [(x["fadeIn"], x["fadeOut"]) for x in case["expect"]]
            self.assertEqual(got, want, case["name"])

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_cuts_get_clip_edge_fades_and_the_gain_stays_in_data_volume(self):
        vdir, out = self.export(fps="25", landscape=True)
        root, clips = self.clips(out)
        fades = lambda i: (clips[i][1].get("data-fade-in"), clips[i][1].get("data-fade-out"))  # noqa: E731
        # the first clip: a fade in at the head, a fade out at the cut; the middle clip: both; the last: the end fade
        self.assertEqual(fades("a-1"), ("0.008", "0.008"))
        self.assertEqual(fades("a-2"), ("0.008", "0.008"))
        self.assertEqual(fades("a-3"), ("0.008", clips["fade-1"][1]["data-duration"]))
        self.assertEqual(fades("b-2"), (None, None))
        for _, a in clips.values():                         # no volume lane any more: the fades are attributes
            self.assertNotIn("data-automation", a)

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_the_end_fade_of_the_sound_is_as_long_as_the_end_fade_picture(self):
        vdir, out = self.export(fps="25", landscape=True)
        root, clips = self.clips(out)
        picture = clips["fade-1"][1]
        self.assertEqual(clips["a-3"][1]["data-fade-out"], picture["data-duration"])

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_a_cut_inside_one_continuous_source_gets_no_de_click(self):
        vdir = make_video(self.tmp, fps="25", landscape=True)
        tl = Timeline.load(vdir / "CLAUDE_VE" / "build" / "timeline.json", base=vdir)
        a, b = tl.spine[0], tl.spine[1]
        c = tl.spine[2]
        b.asset, b.src = a.asset, a.src + a.dur              # the second clip continues the first
        c.src = a.src + a.dur + b.dur + 1                    # the third does not continue the second
        out = hfproject.export(vdir, tl=tl, log=self.log.append)
        root, clips = self.clips(out)
        self.assertEqual(clips["a-1"][1].get("data-fade-in"), "0.008")
        self.assertNotIn("data-fade-out", clips["a-1"][1])   # no fade out at a continued cut
        self.assertNotIn("data-fade-in", clips["a-2"][1])    # nor a fade in
        self.assertEqual(clips["a-2"][1].get("data-fade-out"), "0.008")  # the cut to the third clip is a real cut

    def test_the_shared_folder_link_is_no_symbolic_link(self):
        from vekit import gfx
        link = self.tmp / "shared"
        gfx.link_shared(link)
        self.assertTrue(link.is_dir() and not link.is_symlink())
        self.assertTrue((link / "js" / "gsap.min.js").is_file())

    def test_the_pinned_hyperframes_is_the_servers_and_nobody_pins_another(self):
        from vekit import tools
        self.assertEqual(tools.HYPERFRAMES_PACKAGE, "hyperframes@0.9.80")
        for p in list(KIT.rglob("*.py")):
            self.assertNotIn("hyperframes@0.", p.read_text(encoding="utf-8").replace(tools.HYPERFRAMES_PACKAGE, "")
                             .replace("hyperframes@<pin>", "").replace("hyperframes@<pinned version>", ""), p.name)

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_composition_files_are_sub_compositions_with_unique_ids_and_baked_variables(self):
        vdir, out = self.export(fps="30", landscape=True)
        text = (out / "compositions" / "h-1.html").read_text(encoding="utf-8")
        self.assertIn("<template>", text)
        self.assertIn('data-composition-id="h-1"', text)
        self.assertIn('__timelines["h-1"]', text)
        self.assertIn("Free today", text)
        self.assertNotIn("getVariables", text)
        self.assertNotIn('id="root"', text)
        ov = (out / "compositions" / "ov-1.html").read_text(encoding="utf-8")
        self.assertIn('id="ov-1-card"', ov)
        self.assertIn('getElementById("ov-1-card")', ov)
        self.assertIn("#ov-1-card", ov)
        self.assertNotIn("gsap.min.js", ov)

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_writing_twice_gives_the_same_project_and_no_leftovers(self):
        vdir, out = self.export(fps="30", landscape=True)
        first = (out / "index.html").read_text(encoding="utf-8")
        meta = (out / "meta.json").read_text(encoding="utf-8")
        (out / "stale.txt").write_text("x")
        hfproject.export(vdir, log=self.log.append)
        self.assertEqual((out / "index.html").read_text(encoding="utf-8"), first)
        self.assertEqual((out / "meta.json").read_text(encoding="utf-8"), meta)
        self.assertFalse((out / "stale.txt").exists())
        self.assertEqual(sorted(p.name for p in (vdir / "output").iterdir()), ["Video one.hf"])

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_a_failed_export_keeps_the_old_project(self):
        vdir, out = self.export(fps="30", landscape=True)
        before = (out / "index.html").read_text(encoding="utf-8")
        (vdir / "CLAUDE_VE" / "gfx_src" / "lower" / "index.html").unlink()
        with self.assertRaises(hfproject.ExportError):
            hfproject.export(vdir, log=self.log.append)
        self.assertEqual((out / "index.html").read_text(encoding="utf-8"), before)
        self.assertEqual(sorted(p.name for p in (vdir / "output").iterdir()), ["Video one.hf"])

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_overlaps_and_late_clips_are_repaired_and_said(self):
        vdir = make_video(self.tmp, fps="30", landscape=True)
        tp = vdir / "CLAUDE_VE" / "build" / "timeline.json"
        tl = Timeline.load(tp, base=vdir)
        tl.connected.append(Clip("gfx:lower", 60, rec=45, lane=2, audio=False, name="again"))      # overlaps the first
        tl.connected.append(Clip("gfx:hit_01", 30, rec=400, lane=3, audio=False, name="late"))   # after the end
        tl.save(tp)
        out = hfproject.export(vdir, log=self.log.append)
        self.assertEqual(hfproject.check_project(out), [])
        self.assertTrue(any("overlap" in w for w in self.log), self.log)
        self.assertTrue(any("after the end" in w for w in self.log), self.log)

    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_a_gap_in_the_a_roll_is_refused_in_plain_words(self):
        vdir = make_video(self.tmp, fps="30", landscape=True)
        tp = vdir / "CLAUDE_VE" / "build" / "timeline.json"
        tl = Timeline.load(tp, base=vdir)
        tl.spine.insert(1, Clip("", 10))
        tl.save(tp)
        with self.assertRaises(hfproject.ExportError) as ctx:
            hfproject.export(vdir, log=self.log.append)
        self.assertIn("gap", str(ctx.exception))
        self.assertFalse((vdir / "output" / "Video one.hf").exists())


class CheckProjectTest(common.Case):
    """The self check finds each rule's violation and names the element."""

    def project(self, clips, duration="4", sources=None):
        out = Path(tempfile.mkdtemp(dir=self.tmp))
        (out / "shared" / "js").mkdir(parents=True)
        (out / "shared" / "js" / "gsap.min.js").write_text("//")
        (out / "assets" / "media").mkdir(parents=True)
        (out / "assets" / "media" / "v.mp4").write_text("x")
        (out / "index.html").write_text(
            '<html><head><script src="shared/js/gsap.min.js"></script></head><body>'
            f'<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" '
            f'data-fps="30" data-duration="{duration}">{clips}</div><script>{hfproject.ROOT_SCRIPT}</script></body></html>',
            encoding="utf-8")
        (out / "edit.json").write_text(json.dumps({
            "toolkitVersion": "1", "fps": "30", "width": 1920, "height": 1080,
            "sources": sources if sources is not None else [{"name": "v.mp4", "path": "assets/media/v.mp4",
                                                              "originalPath": "/x/v.mp4", "frames": 300, "fps": "30"}],
            "graphics": []}), encoding="utf-8")
        return out

    @staticmethod
    def video(id="a-1", start="0", dur="4", track=0, kind="aroll", media="0", z=None, src="assets/media/v.mp4"):
        z = track if z is None else z
        return (f'<video id="{id}" class="clip" src="{src}" data-start="{start}" data-duration="{dur}" '
                f'data-media-start="{media}" data-track-index="{track}" data-vidai-kind="{kind}" '
                f'data-vidai-label="L" style="z-index:{z}"></video>')

    def test_a_good_project_passes(self):
        self.assertEqual(hfproject.check_project(self.project(self.video())), [])

    def test_each_rule_is_reported(self):
        cases = {
            "gap": (self.video(dur="2") + self.video("a-2", start="3", dur="1"), "Rule 5"),
            "overlap": (self.video(dur="3") + self.video("a-2", start="2", dur="2"), "Rule 5"),
            "end": (self.video() + self.video("b-1", start="3", dur="2", track=1, kind="broll"), "Rule 5"),
            "same track": (self.video() + self.video("b-1", dur="2", track=1, kind="broll")
                           + self.video("b-2", start="1", dur="2", track=1, kind="broll"), "Rule 6"),
            "wrong track": (self.video() + self.video("b-1", dur="1", track=2, kind="broll"), "Rule 4"),
            "z-index": (self.video(z=3), "Rule 4"),
            "beyond the file": (self.video(media="8"), "Rule 7"),
            "unknown source": (self.video(src="assets/media/w.mp4"), "Rule 7"),
            "dotdot": (self.video(src="../v.mp4"), "Rule 10"),
            "network": (self.video(src="https://x.test/v.mp4"), "Rule 10"),
            "frame": (self.video(dur="3.99"), "Rule 3"),
            "decimals": (self.video(dur="4.0000000001"), "Rule 3"),
            "kind": (self.video(kind="video"), "Rule 3"),
        }
        for name, (clips, rule) in cases.items():
            problems = hfproject.check_project(self.project(clips))
            self.assertTrue(any(p.startswith(rule) for p in problems), (name, problems))

    def test_a_second_script_is_refused(self):
        out = self.project(self.video())
        text = (out / "index.html").read_text(encoding="utf-8").replace("</body>", "<script>gsap.to(1)</script></body>")
        (out / "index.html").write_text(text, encoding="utf-8")
        self.assertTrue(any(p.startswith("Rule 9") for p in hfproject.check_project(out)))

    def test_a_host_must_match_its_file(self):
        host = ('<div id="g-1" class="clip" data-composition-id="g-1" data-composition-src="compositions/g-2.html" '
                'data-start="0" data-duration="1" data-track-index="1" data-vidai-kind="graphic" '
                'data-vidai-label="G" style="z-index:1"></div>')
        problems = hfproject.check_project(self.project(self.video() + host))
        self.assertTrue(any(p.startswith("Rule 8") for p in problems), problems)


class HelpersTest(common.Case):
    def test_numbers_have_at_most_nine_decimals(self):
        self.assertEqual(hfproject.num(Fraction(1001, 30000)), "0.033366667")
        self.assertEqual(hfproject.num(Fraction(5, 2)), "2.5")
        self.assertEqual(hfproject.num(3), "3")
        self.assertEqual(hfproject.num(Fraction(-1, 3)), "-0.333333333")
        self.assertEqual(hfproject.seconds(60, Fraction(30000, 1001)), "2.002")

    def test_link_names_are_safe_and_unique(self):
        taken = set()
        names = []
        for n in ("B-roll 1.mp4", "B-roll_1.mp4", "../x/Vidéo काम.MOV", "..."):
            names.append(hfproject.link_name(n, taken))
            taken.add(names[-1].lower())
        self.assertEqual(names[0], "B-roll_1.mp4")
        self.assertEqual(names[1], "B-roll_1-2.mp4")
        self.assertEqual(len(set(n.lower() for n in names)), 4)
        for n in names:
            self.assertNotRegex(n, r"[ /\\]")

    def test_placement_is_the_default_for_a_plain_clip_and_a_transform_for_a_punch_in(self):
        self.assertEqual(hfproject.place(1920, 1080, 3840, 2160, (0, 0, 1920, 1080)), "")
        css = hfproject.place(1920, 1080, 3840, 2160, (0, 0, 1920, 1080), scale=1.18, pos=(0.0, -3.0))
        self.assertEqual(css, "transform:translate(0px,32.4px) scale(1.18)")

    def test_a_crop_window_fills_the_frame(self):
        # a 16:9 picture, the middle 9:16 window of it, in a 1080x1920 frame: the box is 3.2 times the frame wide
        css = hfproject.place(1080, 1920, 320, 180, (0, 0, 1080, 1920), crop=(0.3418, 0, 0.6582, 1))
        m = {k: float(v[:-2]) for k, v in re.findall(r"(left|top|width|height):(-?[\d.]+px)", css)}
        self.assertAlmostEqual(m["height"], 1920, delta=0.5)
        self.assertAlmostEqual(m["left"] + 0.3418 * m["width"], 0, delta=0.5)
        self.assertAlmostEqual((0.6582 - 0.3418) * m["width"], 1080, delta=1)

    def test_a_turned_picture_swaps_its_box(self):
        css = hfproject.place(1080, 1920, 3840, 2160, (0, 0, 1080, 1920), rot=90)
        m = {k: float(v[:-2]) for k, v in re.findall(r"(left|top|width|height):(-?[\d.]+px)", css)}
        self.assertAlmostEqual(m["width"] / m["height"], 3840 / 2160, places=3)
        self.assertIn("rotate(90deg)", css)

    def test_the_root_script_is_the_servers(self):
        if not SERVER_ROOT_SCRIPT.exists():
            self.skipTest("the server is not part of this checkout")
        text = SERVER_ROOT_SCRIPT.read_text(encoding="utf-8")
        m = re.search(r"ROOT_SCRIPT\s*=\s*`(.*?)`", text, re.S)
        self.assertIsNotNone(m, "rootScript.js no longer defines ROOT_SCRIPT as a template string")
        server = m.group(1).replace("\\`", "`").replace("\\\\", "\\").replace("\r\n", "\n").strip()
        ours = (Path(hfproject.__file__).with_name("hf_root_script.js")).read_text(encoding="utf-8").replace("\r\n", "\n").strip()
        self.assertEqual(ours, server)


class CommandTest(common.Case):
    @common.unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_hf_and_review_write_the_project_and_fail_with_a_sentence(self):
        vdir = make_video(self.tmp, fps="30", landscape=True)
        env = common.clean_env(PYTHONDONTWRITEBYTECODE="1")
        for cmd in ("hf", "review"):
            r = subprocess.run([sys.executable, str(VE), cmd, str(vdir)], capture_output=True, text=True,
                               encoding="utf-8", env=env, stdin=subprocess.DEVNULL, cwd=self.tmp)
            self.assertEqual(r.returncode, 0, r.stderr[-600:])
            self.assertIn("self check: OK", r.stdout)
            self.assertTrue(r.stdout.strip().endswith("Video one.hf"), r.stdout[-200:])
        shutil.rmtree(vdir / "CLAUDE_VE" / "gfx_src")
        r = subprocess.run([sys.executable, str(VE), "hf", str(vdir)], capture_output=True, text=True,
                           encoding="utf-8", env=env, stdin=subprocess.DEVNULL, cwd=self.tmp)
        self.assertEqual(r.returncode, 1)
        self.assertIn("has no composition", r.stderr)
        self.assertNotIn("Traceback", r.stderr)


if __name__ == "__main__":
    common.unittest.main()
