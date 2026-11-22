"""`ve.py frames --project` (vekit/projectframes.py): frames of the written HyperFrames project and the numeric checks.

The structure tests run anywhere (a fake `hyperframes snapshot` where the browser is needed); the real snapshot tests
run where ffmpeg and the pinned HyperFrames with its browser are installed and are skipped otherwise."""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

import common
import test_graphic
import test_hfproject
from vekit import hfproject, projectframes as pf, resources
from vekit.paths import KIT

VE = KIT / "ve.py"
HF_MJS = test_graphic.hyperframes_mjs()

INDEX = """<!doctype html><html><body>
<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="60">
<video id="a-1" class="clip" src="assets/media/Main.mp4" data-start="0" data-duration="60" data-media-start="0" data-track-index="0" data-vidai-kind="aroll" style="z-index:0;transform:translate(0px,32.4px) scale(1.1)"></video>
<div id="g-1" class="clip" data-composition-id="g-1" data-composition-src="compositions/g-1.html" data-start="10" data-duration="3" data-track-index="1" data-vidai-kind="graphic" data-vidai-label="Title" style="z-index:1"></div>
<div id="b-1" class="clip" data-composition-id="b-1" data-composition-src="compositions/b-1.html" data-start="20" data-duration="8" data-track-index="1" data-vidai-kind="broll" style="z-index:1"></div>
<div id="ov-1" class="clip" data-composition-id="ov-1" data-composition-src="compositions/ov-1.html" data-start="21" data-duration="2" data-track-index="2" data-vidai-kind="overlay" style="z-index:2"></div>
<div id="h-1" class="clip" data-composition-id="h-1" data-composition-src="compositions/h-1.html" data-start="30" data-duration="1" data-track-index="3" data-vidai-kind="hit" style="z-index:3"></div>
<audio id="s-1" class="clip" src="assets/sfx/pop1.wav" data-start="10" data-duration="1" data-track-index="10" data-vidai-kind="sfx"></audio>
</div></body></html>"""


def solid(w, h, rgb):
    return (w, h, bytes(rgb) * (w * h))


def args(main, **kw):
    ns = dict(main=str(main), res="720", times=None, every=None, project=True, timeline=None)
    ns.update(kw)
    return argparse.Namespace(**ns)


class PlanTest(common.Case):
    def clips(self):
        return pf.read_clips(INDEX)

    def test_clips_are_read_with_kind_track_and_time(self):
        root, clips = self.clips()
        self.assertEqual(root["data-duration"], "60")
        kinds = {c["id"]: (c["kind"], c["track"], c["start"], c["dur"]) for c in clips}
        self.assertEqual(kinds["g-1"], ("graphic", 1, 10.0, 3.0))
        self.assertEqual(kinds["a-1"][:2], ("aroll", 0))
        self.assertEqual(pf.clip_at(clips, 21.5)["id"], "ov-1")             # the highest track on screen
        self.assertEqual(pf.clip_at(clips, 10.5)["id"], "g-1")              # sound clips never count
        self.assertEqual(pf.clip_at(clips, 5)["id"], "a-1")
        self.assertIsNone(pf.clip_at(clips, 61))

    def test_default_plan_has_a_frame_in_every_picture_clip_and_some_host_frames(self):
        root, clips = self.clips()
        times, available = pf.default_times(clips, 60)
        self.assertEqual(times, sorted(times))
        self.assertEqual(available, len(times))
        shown = [pf.clip_at(clips, t)["id"] for t in times]
        for cid in ("g-1", "h-1", "ov-1"):
            self.assertIn(cid, shown)
        self.assertEqual(shown.count("b-1"), 2)                                # 8 s: two frames
        self.assertEqual(shown.count("a-1"), pf.HOST_FRAMES)
        self.assertTrue(all(0 < t < 60 for t in times))

    def test_a_frame_is_where_its_clip_is_on_top(self):
        root, clips = self.clips()
        times, _ = pf.default_times(clips, 60)
        self.assertEqual(len([t for t in times if 20 <= t < 28 and pf.clip_at(clips, t)["id"] == "b-1"]), 2)

    def test_the_plan_is_capped_and_keeps_full_screen_clips_first(self):
        rows = "".join(f'<div id="g-{i}" class="clip" data-start="{i * 3}" data-duration="2" data-track-index="1" '
                       f'data-vidai-kind="graphic"></div>' for i in range(60))
        root, clips = pf.read_clips(f'<div id="root" data-duration="200">{rows}</div>')
        times, available = pf.default_times(clips, 200)
        self.assertEqual((len(times), available), (pf.MAX_FRAMES, 60 + pf.HOST_FRAMES))
        self.assertTrue(all(pf.clip_at(clips, t) is not None and pf.clip_at(clips, t)["kind"] == "graphic" for t in times))

    def test_times_and_every(self):
        self.assertEqual(pf.parse_times(["1,2.5", "4"]), [1.0, 2.5, 4.0])
        for bad in (["x"], ["-1"], ["nan"]):
            with self.assertRaises(pf.FramesError):
                pf.parse_times(bad)
        self.assertEqual(pf.every_times(10, 4), [2.0, 6.0])                    # the middle of each span
        with self.assertRaises(pf.FramesError):
            pf.every_times(10, 0)


class MetricsTest(common.Case):
    def test_match_black_and_difference(self):
        a, b = solid(8, 4, (90, 110, 140)), solid(8, 4, (100, 100, 150))
        self.assertEqual(pf.match_fraction(a, b), 1.0)
        self.assertEqual(pf.match_fraction(a, solid(8, 4, (200, 10, 10))), 0.0)
        half = (8, 4, bytes((90, 110, 140) * 16 + (0, 0, 0) * 16))
        self.assertEqual(pf.match_fraction(a, half), 0.5)
        self.assertTrue(pf.is_black(solid(8, 4, (0, 0, 0))))
        self.assertFalse(pf.is_black(a))
        self.assertAlmostEqual(pf.mean_diff(a, a), 0)
        self.assertGreater(pf.mean_diff(a, solid(8, 4, (255, 255, 255))), 0.3)

    def test_the_punch_in_is_read_from_the_clip_style(self):
        self.assertEqual(pf._transform("z-index:0;transform:translate(0px,32.4px) scale(1.1)"), (1.1, 0.0, 32.4))
        self.assertEqual(pf._transform("z-index:0"), (1.0, 0.0, 0.0))

    def frame(self, t, cid, kind, rgb, host=(90, 110, 140)):
        c = {"id": cid, "kind": kind, "label": ""}
        return {"t": t, "clip": c, "name": f"{cid} ({kind})", "thumb": solid(8, 4, rgb), "host": solid(8, 4, host)}

    def test_a_full_screen_frame_that_is_the_host_is_flagged_and_a_real_one_is_not(self):
        warns = pf.check_frames([self.frame(1, "g-1", "graphic", (92, 108, 142)), self.frame(5, "g-2", "graphic", (30, 60, 200))])
        self.assertEqual(len(warns), 1, warns)
        self.assertIn("g-1", warns[0])
        self.assertIn("host", warns[0])

    def test_an_overlay_may_show_the_host(self):
        self.assertEqual(pf.check_frames([self.frame(1, "ov-1", "overlay", (92, 108, 142))]), [])

    def test_black_frames_are_flagged_except_the_end_fade(self):
        warns = pf.check_frames([self.frame(1, "g-1", "graphic", (0, 0, 0)), self.frame(9, "fade-1", "fade", (0, 0, 0))])
        self.assertEqual([w.split()[1] for w in warns if "black" in w], ["t=1.00s"])

    def test_two_clips_with_the_same_picture_are_flagged(self):
        warns = pf.check_frames([self.frame(1, "g-1", "graphic", (30, 60, 200)), self.frame(5, "g-2", "graphic", (30, 60, 200)),
                                 self.frame(9, "g-3", "graphic", (200, 60, 30))])
        self.assertEqual(len([w for w in warns if "identical" in w]), 1, warns)
        self.assertIn("g-2", [w for w in warns if "identical" in w][0])


class SnapshotCommandTest(common.Case):
    def test_the_command_has_no_shell_one_call_and_holds_the_gpu_slot(self):
        calls, events = [], []

        class Slot:
            def __enter__(self):
                events.append("in")

            def __exit__(self, *a):
                events.append("out")

        def fake_run(cmd, **kw):
            calls.append((cmd, kw))
            events.append("run")
            out = Path(cmd[cmd.index("-o") + 1])
            for i, t in enumerate(cmd[cmd.index("--at") + 1].split(",")):
                (out / f"frame-{i:02d}-at-{t}s.png").write_bytes(b"x")
            return subprocess.CompletedProcess(cmd, 0, "", "")

        folder = self.tmp / "My video – A & B" / "output" / "x.hf"
        folder.mkdir(parents=True)
        out = self.tmp / "out"
        out.mkdir()
        with mock.patch.object(pf.subprocess, "run", fake_run), mock.patch.object(pf.resources, "gpu_slot", Slot), \
                mock.patch.object(pf.tools, "hyperframes", return_value=["hf"]):
            pngs = pf.snapshot(folder, [1.5, 3.0], out, 60)
        cmd, kw = calls[0]
        self.assertEqual(cmd[:3], ["hf", "snapshot", str(folder)])
        self.assertEqual(cmd[cmd.index("--at") + 1], "1.5,3")
        self.assertIn("--no-end", cmd)
        self.assertFalse(kw.get("shell"))
        self.assertEqual(events, ["in", "run", "out"])
        self.assertEqual([p.name for p in pngs], ["frame-00-at-1.5s.png", "frame-01-at-3s.png"])

    def test_a_missing_hyperframes_is_one_line(self):
        with mock.patch.object(pf.tools, "hyperframes", return_value=[str(self.tmp / "no-such-program")]):
            with self.assertRaises(pf.FramesError) as cm:
                pf.snapshot(self.tmp, [1.0], self.tmp, 10)
        self.assertNotIn("\n", str(cm.exception))
        self.assertIn("HyperFrames", str(cm.exception))

    def test_a_failing_snapshot_reports_the_error_line(self):
        r = subprocess.CompletedProcess([], 1, "", "Node.js v22\nError: Cannot find module 'x'\nNode.js v22.22.2\n")
        with mock.patch.object(pf.subprocess, "run", return_value=r), mock.patch.object(pf.tools, "hyperframes", return_value=["hf"]):
            with self.assertRaises(pf.FramesError) as cm:
                pf.snapshot(self.tmp, [1.0], self.tmp, 10)
        self.assertIn("Cannot find module", str(cm.exception))


class CommandLineTest(common.Case):
    def ve(self, *a):
        return subprocess.run([sys.executable, str(VE), *a], capture_output=True, text=True, encoding="utf-8",
                              env=common.clean_env(), stdin=subprocess.DEVNULL)

    def test_no_project_is_one_error_line(self):
        (self.tmp / "v").mkdir()
        r = self.ve("frames", str(self.tmp / "v"), "--project")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(len(r.stderr.strip().splitlines()), 1, r.stderr)
        self.assertIn("ve.py hf", r.stderr)

    def test_times_without_project_is_refused(self):
        r = self.ve("frames", str(self.tmp), "--times", "1")
        self.assertEqual(r.returncode, 1)
        self.assertIn("--project", r.stderr)

    def test_2160_is_refused(self):
        r = self.ve("frames", str(self.tmp), "--project", "--res", "2160")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("720 or 1080", r.stderr)

    def test_the_module_docstring_lists_the_option(self):
        text = VE.read_text(encoding="utf-8")
        self.assertIn("frames <VIDEO> --project", text)


@common.unittest.skipUnless(HF_MJS, "needs ffmpeg and the pinned HyperFrames with its browser (node_modules/hyperframes, ~/.cache/hyperframes/chrome)")
class RealSnapshotTest(common.Case):
    """A real `hyperframes snapshot` of a written project, in a folder whose name has spaces, an en dash and an ampersand."""

    def setUp(self):
        super().setUp()
        patcher = mock.patch.dict(os.environ, {"VE_HYPERFRAMES": HF_MJS})
        patcher.start()
        self.addCleanup(patcher.stop)

    def project(self):
        """Video with one full-screen blue graphic (g-1, 1.0 to 2.0 s) over the flat host."""
        vdir = test_hfproject.make_video(self.tmp / "Café – A & B", fps="30", landscape=True)
        src = vdir / "CLAUDE_VE" / "gfx_src" / "lower" / "index.html"
        src.write_text(src.read_text(encoding="utf-8").replace("background: transparent", "background: #2040c0"), encoding="utf-8")
        path = vdir / "CLAUDE_VE" / "build" / "timeline.json"
        tl = json.loads(path.read_text(encoding="utf-8"))
        tl["assets"]["gfx:lower"]["alpha"] = False
        path.write_text(json.dumps(tl), encoding="utf-8")
        out = hfproject.export(vdir, log=lambda _: None)
        return vdir, out

    def frames(self, vdir, **kw):
        lines = []
        code = pf.run(args(vdir, **kw), say=lines.append)
        return code, lines

    def test_default_plan_writes_frames_sheet_and_one_line_each(self):
        from PIL import Image
        vdir, project = self.project()
        code, lines = self.frames(vdir)
        self.assertEqual(code, 0, lines)
        out = vdir / "CLAUDE_VE" / "frames_project"
        listed = [Path(x.split("-> ", 1)[1]) for x in lines if x.startswith("t=")]
        self.assertTrue(listed)
        self.assertTrue(all(p.is_file() and p.parent == out for p in listed))
        self.assertTrue((out / "sheet_1.jpg").is_file())
        self.assertIn("g-1 graphic", " ".join(lines))
        with Image.open(listed[0]) as im:
            self.assertEqual(im.size, (1280, 720))                              # 720 even though the project is 1080
        # the fixture's b-roll files are the same flat colour as the host, so only the graphic is held to the checks
        self.assertFalse([x for x in lines if x.startswith("WARN") and "g-1" in x], lines)

    def test_res_1080_keeps_the_size_and_a_second_run_replaces_the_files(self):
        from PIL import Image
        vdir, project = self.project()
        code, lines = self.frames(vdir, times=["1.5"], res="1080")
        self.assertEqual(code, 0, lines)
        out = vdir / "CLAUDE_VE" / "frames_project"
        with Image.open(next(out.glob("00_*.jpg"))) as im:
            self.assertEqual(im.size, (1920, 1080))
        self.frames(vdir, times=["1.5", "4.5"], res="720")
        self.assertEqual(len(list(out.glob("[0-9][0-9]_*.jpg"))), 2)

    def test_a_graphic_that_shows_the_host_is_flagged(self):
        vdir, project = self.project()
        comp = project / "compositions" / "g-1.html"
        comp.write_text(comp.read_text(encoding="utf-8").replace("#2040c0", "transparent"), encoding="utf-8")
        code, lines = self.frames(vdir, times=["1.5"])
        self.assertEqual(code, 0, lines)
        self.assertTrue([x for x in lines if x.startswith("WARN") and "A-roll host frame" in x and "g-1" in x], lines)

    def test_a_black_graphic_is_flagged(self):
        vdir, project = self.project()
        comp = project / "compositions" / "g-1.html"
        comp.write_text(comp.read_text(encoding="utf-8").replace("#2040c0", "#000").replace("#e33", "#000"), encoding="utf-8")
        code, lines = self.frames(vdir, times=["1.5"])
        self.assertTrue([x for x in lines if x.startswith("WARN") and "black frame" in x], lines)

    def test_every_gives_the_middle_of_each_span(self):
        vdir, project = self.project()
        code, lines = self.frames(vdir, every=3.0)
        self.assertEqual(code, 0, lines)
        self.assertEqual([x.split()[0] for x in lines if x.startswith("t=")], ["t=1.50s", "t=4.50s"])


if __name__ == "__main__":
    common.unittest.main()
