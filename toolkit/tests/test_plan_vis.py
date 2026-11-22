"""Every way a VIS entry can fail to make its own visible interval is a WARN line that names the entry.

The video has one A-roll part with kept audio 1.0-4.0 s and 6.0-9.0 s (so 4.0-6.0 s is cut) at 24 fps:
output frame 0-72 is the first piece, 72-144 the second, then the held quiet at the end.
"""
import json
import subprocess
import sys
import unittest

import common

VE = common.KIT / "ve.py"
HOLD = "END_HOLD=0.3\n"


@unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg and ffprobe")
class VisWarnings(common.Case):
    def setUp(self):
        super().setUp()
        self.video = self.tmp / "Video"
        self.video.mkdir()
        common.make_clip(self.video / "Main.mp4", size="1280x720", seconds=12, fps=24)
        self.base = common.clean_env(VE_HW="none", VE_CPU_CORES="4", PYTHONDONTWRITEBYTECODE="1")
        r = subprocess.run([sys.executable, str(VE), "prep", str(self.video)], env=self.base, capture_output=True,
                           text=True, encoding="utf-8", stdin=subprocess.DEVNULL, timeout=600)
        self.assertEqual(r.returncode, 0, r.stdout[-800:] + r.stderr[-800:])
        cv = self.video / "CLAUDE_VE"
        (cv / "transcripts").mkdir(exist_ok=True)
        (cv / "transcripts" / "a1.chunks.json").write_text(
            json.dumps({"model": "x", "chunks": [{"i": 0, "s": 0.0, "e": 1.0, "text": "", "words": []}]}),
            encoding="utf-8")
        gfx = cv / "gfx_src" / "x"
        gfx.mkdir(parents=True)
        (gfx / "index.html").write_text('<div data-composition-id="main" data-duration="20"></div>', encoding="utf-8")

    def plan(self, vis, extra=""):
        exact = '{"in": "exact", "out": "exact"}'
        (self.video / "CLAUDE_VE" / "timeline.py").write_text(
            f"SEGS=[(1.0,4.0,{exact}),(6.0,9.0,{exact})]\nVIS={vis}\n{HOLD}{extra}", encoding="utf-8")
        from vekit.plan import plan
        tl, warns = plan(self.video, write=False)
        return tl, [w for w in warns if w.startswith("VIS entry")]

    def test_plain_entries_make_no_warning(self):
        _, warns = self.plan('[(1.0,"H"),(2.0,"G:x"),(3.0,"H"),(7.0,"G:x"),(8.0,"H")]')
        self.assertEqual(warns, [])

    def test_anchor_in_cut_audio_moves_to_the_next_kept_frame(self):
        _, warns = self.plan('[(1.0,"H"),(5.0,"G:x")]')
        self.assertEqual(len(warns), 1, warns)
        w = warns[0]
        self.assertIn("a1 5.00s G:x", w)
        self.assertIn("cut audio", w)
        self.assertIn("pause longer than", w)
        self.assertIn("3.00s of the output", w)
        self.assertIn("6.00s of a1", w)

    def test_anchor_snapped_onto_a_jump_cut(self):
        _, warns = self.plan('[(1.0,"H"),(6.1,"HT")]')
        self.assertEqual(len(warns), 1, warns)
        self.assertIn("a1 6.10s HT", warns[0])
        self.assertIn("2 frames", warns[0])
        self.assertIn("jump cut", warns[0])
        self.assertIn("3.00s of the output", warns[0])

    def test_two_entries_on_the_same_frame_drop_the_first(self):
        tl, warns = self.plan('[(1.0,"H"),(7.0,"HW"),(7.0,"HT")]')
        self.assertEqual(len(warns), 1, warns)
        self.assertIn("a1 7.00s HW", warns[0])
        self.assertIn("dropped", warns[0])
        self.assertIn("a1 7.00s HT", warns[0])
        self.assertIn("same frame", warns[0])

    def test_two_anchors_in_the_same_cut_land_on_one_frame(self):
        _, warns = self.plan('[(1.0,"H"),(4.5,"G:x"),(5.5,"H")]')
        self.assertTrue(any("a1 4.50s G:x" in w and "dropped" in w and "a1 5.50s H" in w for w in warns), warns)

    def test_anchor_after_the_last_kept_audio_is_dropped(self):
        _, warns = self.plan('[(1.0,"H"),(10.5,"G:x")]')
        self.assertEqual(len(warns), 1, warns)
        self.assertIn("a1 10.50s G:x", warns[0])
        self.assertIn("after the last kept audio", warns[0])
        self.assertIn("dropped", warns[0])

    def test_unknown_part_and_unknown_kind(self):
        _, warns = self.plan('[(1.0,"H"),("a9",2.0,"G:x"),(3.0,"Host")]')
        self.assertTrue(any("a9 2.00s G:x" in w and "not an A-roll part" in w and "a1" in w for w in warns), warns)
        self.assertTrue(any("a1 3.00s Host" in w and "not a kind" in w and "treated as H" in w for w in warns), warns)

    def test_short_host_interval_after_a_graphic_is_swallowed(self):
        tl, warns = self.plan('[(1.0,"H"),(2.0,"G:x"),(2.3,"H"),(2.8,"G:x"),(3.3,"H")]')
        self.assertEqual(len(warns), 1, warns)
        self.assertIn("a1 2.30s H", warns[0])
        self.assertIn("dropped", warns[0])
        self.assertIn("0.6", warns[0])
        self.assertIn("a1 2.00s G:x", warns[0])
        self.assertIn("1.79s", warns[0])

    def test_host_just_before_a_cut_starts_at_the_cut(self):
        _, warns = self.plan('[(1.0,"H"),(2.0,"G:x"),(3.6,"H")]')
        self.assertEqual(len(warns), 1, warns)
        self.assertIn("a1 3.60s H", warns[0])
        self.assertIn("moved", warns[0])
        self.assertIn("3.00s", warns[0])
        self.assertIn("a1 2.00s G:x", warns[0])

    def test_host_piece_shorter_than_min_framing_frames_takes_the_neighbours_framing(self):
        project = self.video / "CLAUDE_VE" / "project.json"
        data = json.loads(project.read_text(encoding="utf-8"))
        data["min_framing_frames"] = 12
        project.write_text(json.dumps(data), encoding="utf-8")
        _, warns = self.plan('[(1.0,"HW"),(3.0,"HT"),(3.4,"HW")]')
        self.assertEqual(len(warns), 1, warns)
        self.assertIn("a1 3.00s HT", warns[0])
        self.assertIn("min_framing_frames (12", warns[0])
        self.assertIn("no change shows", warns[0])

    def test_plan_writes_its_full_report_in_utf8_and_says_so(self):
        self.plan('[(1.0,"H"),(5.0,"G:x")]')                                             # writes timeline.py
        r = subprocess.run([sys.executable, str(VE), "plan", str(self.video)], env=self.base, capture_output=True,
                           text=True, encoding="utf-8", stdin=subprocess.DEVNULL, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        report = self.video / "CLAUDE_VE" / "plan.txt"
        raw = report.read_bytes()
        self.assertFalse(raw.startswith((b"\xff\xfe", b"\xef\xbb\xbf")))
        text = raw.decode("utf-8")
        self.assertIn("visible shots", text)
        self.assertRegex(text, r"(?m)^ +\d+\.\d\d +\d+\.\d\ds ")                      # the verbose rows
        self.assertIn("WARN VIS entry a1 5.00s G:x", text)
        lines = [ln for ln in r.stdout.splitlines() if "plan.txt" in ln]
        self.assertEqual(len(lines), 1, r.stdout)
        self.assertNotIn("\n  ", r.stdout.replace("\r", ""))                           # no verbose rows on screen
        self.assertIn("WARN VIS entry a1 5.00s G:x", r.stdout)


if __name__ == "__main__":
    unittest.main()
