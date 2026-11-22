"""The toolkit's commands end to end on a tiny real video: prep, plan, build, review projects, QA.

HyperFrames is replaced by support/fake_npx.py (VE_NPX), so nothing needs the network or Chrome.
"""
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

import common

VE = common.KIT / "ve.py"


def run(*args, cwd=None, env=None, check=True):
    r = subprocess.run([sys.executable, *map(str, args)], cwd=cwd, env=env, capture_output=True, text=True,
                       encoding="utf-8", stdin=subprocess.DEVNULL, timeout=600)
    if check and r.returncode != 0:
        raise AssertionError(f"{' '.join(map(str, args))}\n{r.stdout[-1500:]}\n{r.stderr[-1500:]}")
    return r


@unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg and ffprobe")
class PipelineTest(common.Case):
    maxDiff = None

    def setUp(self):
        super().setUp()
        # the folder name has spaces, accents and Devanagari; it lies outside the toolkit and the repo
        self.channel = self.tmp / "Chan nel"
        self.video = self.channel / "Vidéo काम 1"
        self.video.mkdir(parents=True)
        common.make_clip(self.video / "Main.mp4", size="3840x2160", seconds=2)   # the planner crops in 4K pixels
        self.log = self.tmp / "npx.log"
        self.slots = self.tmp / "slots"
        self.slots.mkdir()
        (self.slots / "limits.json").write_text('{"total": 1, "perJob": 1}')
        self.base = common.clean_env(VE_HW="none", VE_CPU_CORES="4", VE_NPX=str(common.FAKE_NPX),
                                     FAKE_NPX_LOG=str(self.log), PYTHONDONTWRITEBYTECODE="1")

    def ve(self, *args, env=None, cwd=None, check=True):
        return run(VE, *args, env=env or self.base, cwd=cwd or self.tmp, check=check)

    def write_edit(self, video=None):
        video = video or self.video
        (video / "CLAUDE_VE" / "transcripts").mkdir(parents=True, exist_ok=True)
        words = [{"w": w, "s": round(0.2 + i * 0.3, 2), "e": round(0.45 + i * 0.3, 2), "p": 0.9}
                 for i, w in enumerate("नमस्ते दोस्तों आज हम एक वीडियो".split())]
        (video / "CLAUDE_VE" / "transcripts" / "a1.chunks.json").write_text(
            json.dumps({"model": "x", "chunks": [{"i": 0, "s": 0.1, "e": 1.9, "text": "x", "words": words}]},
                       ensure_ascii=False), encoding="utf-8")
        (video / "CLAUDE_VE" / "timeline.py").write_text('SEGS=[(0.2,1.7)]\nVIS=[(0.2,"H")]\nEND_HOLD=0.3\n',
                                                         encoding="utf-8")

    def prepared(self):
        self.ve("prep", self.video)
        self.write_edit()
        self.ve("plan", self.video)

    # ---------------------------------------------------------------------------- tests
    def test_prep_and_plan_work_from_any_directory_and_leave_the_toolkit_alone(self):
        with common.no_new_files(common.TOOLKIT):
            r = self.ve("prep", self.video)
            self.assertIn("Main.mp4  3840x2160", r.stdout)
            self.write_edit()
            r = self.ve("plan", self.video)
            self.assertIn("1 spine clips", r.stdout)
        cv = self.video / "CLAUDE_VE"
        proj = json.loads((cv / "project.json").read_text(encoding="utf-8"))
        self.assertEqual((proj["width"], proj["height"], proj["aroll"]), (3840, 2160, {"a1": "Main.mp4"}))
        recon = json.loads((cv / "build" / "recon.json").read_text(encoding="utf-8"))
        self.assertEqual(recon["a1"]["audio_16k"], "CLAUDE_VE/audio/a1_16k.wav")      # relative to the video folder
        tl = json.loads((cv / "build" / "timeline.json").read_text(encoding="utf-8"))
        self.assertEqual(tl["assets"]["aroll:a1"]["file"], "Main.mp4")
        text = (cv / "build" / "timeline.json").read_text(encoding="utf-8")
        self.assertNotIn(str(self.tmp), text)                                         # no machine path is stored
        self.assertTrue((cv / "audio" / "a1_48k.wav").exists())

    def test_relative_video_folder_resolves_against_the_current_directory(self):
        self.ve("prep", "Chan nel/Vidéo काम 1", cwd=self.tmp)
        self.assertTrue((self.video / "CLAUDE_VE" / "project.json").exists())
        self.ve("prep", "Vidéo काम 1", cwd=self.channel)
        self.ve("prep", "..", cwd=self.video / "CLAUDE_VE")

    def test_every_render_command_refuses_2160(self):
        self.prepared()
        for args in (("gfx", "--res", "1080", "2160"), ("build", "--res", "2160"), ("frames", "--res", "2160"),
                     ("qa", "--res", "2160")):
            r = self.ve(args[0], self.video, *args[1:], check=False)
            self.assertNotEqual(r.returncode, 0, args)
            self.assertIn("only for the final render", r.stderr)
            self.assertEqual(len(r.stderr.strip().splitlines()), 1, r.stderr)

    def test_build_fcp_premiere_import_qa(self):
        self.prepared()
        cv = self.video / "CLAUDE_VE"
        with common.no_new_files(common.TOOLKIT):
            r = self.ve("build", self.video, "--res", "720")
            self.assertIn("graphics: 1 rendered", r.stdout)
            preview = cv / "renders" / "preview_720.mp4"
            self.assertTrue(preview.exists())
            probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height",
                                    "-of", "csv=p=0", str(preview)], capture_output=True, text=True).stdout
            self.assertIn("h264,1280,720", probe)
            r = self.ve("fcp", self.video)
            self.assertIn("round trip: identical", r.stdout)
            self.ve("premiere", self.video)
            out = self.video / "output"
            names = sorted(p.name for p in out.iterdir())
            self.assertEqual(names, ["Vidéo काम 1_review_v1.fcpxml", "Vidéo काम 1_review_v1.xml"])
            fcp = (out / names[0]).read_text(encoding="utf-8")
            self.assertIn("Vid%C3%A9o%20%E0%A4%95", fcp)                              # media URLs are encoded
            r = self.ve("import", self.video, out / names[0])
            self.assertIn("0 differences", r.stdout)
            r = self.ve("frames", self.video, "--res", "720")
            self.assertIn("2 shots", r.stdout)
            r = self.ve("qa", self.video, "--res", "720")
            self.assertIn("LUFS", r.stdout)
            r = self.ve("audio", self.video)
            self.assertIn("LUFS", r.stdout)

    def test_broll_is_conformed_and_keeps_relative_paths(self):
        self.ve("prep", self.video)
        (self.video / "broll").mkdir()
        common.make_clip(self.video / "broll" / "clip one.mp4", size="1920x1080", seconds=2, audio=False)
        self.write_edit()
        (self.video / "CLAUDE_VE" / "timeline.py").write_text(
            'SEGS=[(0.2,1.7)]\nVIS=[(0.2,"H"),(0.8,"B:c1"),(1.3,"H")]\nEND_HOLD=0.3\n'
            'BROLL={"c1": {"file": "broll/clip one.mp4", "in": 0.0, "motion": "none"}}\n', encoding="utf-8")
        r = self.ve("plan", self.video)
        self.assertIn("1 b-roll", r.stdout)
        r = self.ve("broll", self.video)
        self.assertIn("b-roll: 1 rendered", r.stdout)
        tl = json.loads((self.video / "CLAUDE_VE" / "build" / "timeline.json").read_text(encoding="utf-8"))
        asset = next(a for a in tl["assets"].values() if a["kind"] == "broll")
        self.assertEqual(asset["src_file"], "broll/clip one.mp4")
        self.assertTrue(asset["file"].startswith("CLAUDE_VE/"))
        self.assertTrue((self.video / asset["file"]).exists())
        r = self.ve("broll", self.video)
        self.assertIn("1 cached", r.stdout)

    def test_moving_the_video_folder_keeps_the_timeline_valid(self):
        self.prepared()
        self.ve("gfx", self.video)
        moved = self.tmp / "moved here" / "Another name"
        moved.parent.mkdir()
        shutil.move(str(self.video), str(moved))
        r = self.ve("fcp", moved)                                                      # no new plan: stored paths are relative
        self.assertIn("round trip: identical", r.stdout)
        self.assertTrue((moved / "output" / "Another name_review_v1.fcpxml").exists())

    def test_graphics_run_under_a_gpu_slot_with_the_server_environment(self):
        self.prepared()
        env = dict(self.base, VE_GPU_SLOTS_DIR=str(self.slots), VE_JOB_ID="job-7", VE_CPU_CORES="8")
        self.ve("gfx", self.video, env=env)
        calls = [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["slots"], ["slot-0"])                                # held while HyperFrames ran
        self.assertTrue(calls[0]["shared"])                                            # the shared kit is linked in
        a = calls[0]["args"]
        self.assertEqual(a[a.index("--workers") + 1], "4")                             # 8 cores -> 4 workers
        self.assertEqual(sorted(p.name for p in self.slots.glob("slot-*")), [])        # released afterwards

    def test_without_the_server_environment_no_slot_is_used(self):
        self.prepared()
        self.ve("gfx", self.video)
        self.assertIsNone(json.loads(self.log.read_text(encoding="utf-8").splitlines()[0])["slots"])

    def test_the_shot_cache_does_not_depend_on_hardware_or_cores(self):
        self.prepared()
        self.ve("build", self.video, "--res", "720")
        env = dict(self.base, VE_CPU_CORES="2")
        env.pop("VE_HW")                                                               # whatever this machine has
        r = self.ve("build", self.video, "--res", "720", env=env)
        self.assertIn("0 to render", r.stdout)

    def test_hardware_build_when_the_machine_has_it(self):
        self.prepared()
        env = dict(self.base)
        env.pop("VE_HW")
        self.ve("build", self.video, "--res", "720", env=env)
        self.assertTrue((self.video / "CLAUDE_VE" / "renders" / "preview_720.mp4").exists())

    def test_thumbs_sheet_words_timing(self):
        self.prepared()
        src = self.video / "CLAUDE_VE" / "thumb_src" / "1"
        src.mkdir(parents=True)
        (src / "index.html").write_text('<div data-composition-id="m" data-width="1920" data-height="1080" '
                                        'data-duration="1"></div>', encoding="utf-8")
        with common.no_new_files(common.TOOLKIT):
            run(common.KIT / "thumbs.py", "render", self.video, env=self.base, cwd=self.tmp)
            out = self.video / "output" / "thumbnail-1.png"
            self.assertTrue(out.exists())
            from PIL import Image
            with Image.open(out) as im:
                self.assertEqual(im.size, (1280, 720))
            sheet = self.tmp / "sheet out.jpg"
            run(common.KIT / "sheet.py", self.video / "Main.mp4", sheet, "--times", "0.2,1.0", "--cols", "2",
                "--width", "200", env=self.base, cwd=self.tmp)
            self.assertTrue(sheet.exists())
            r = run(common.KIT / "words.py", self.video, "a1", "0", "1", env=self.base, cwd=self.tmp)
            self.assertIn("0.20|नमस्ते|0.45", r.stdout)
            run(common.KIT / "timing.py", self.video, "start", "plan", env=self.base, cwd=self.tmp)
            run(common.KIT / "timing.py", self.video, "end", "plan", env=self.base, cwd=self.tmp)
            r = run(common.KIT / "timing.py", self.video, "write", env=self.base, cwd=self.tmp)
        self.assertTrue((self.video / "info.txt").exists())
        self.assertIn("Transcription to written edit plan", (self.video / "info.txt").read_text(encoding="utf-8"))

    def test_thumbnail_snapshot_runs_under_a_slot(self):
        self.prepared()
        src = self.video / "CLAUDE_VE" / "thumb_src" / "1"
        src.mkdir(parents=True)
        (src / "index.html").write_text('<div data-width="1920" data-height="1080"></div>', encoding="utf-8")
        env = dict(self.base, VE_GPU_SLOTS_DIR=str(self.slots), VE_JOB_ID="job-8")
        run(common.KIT / "thumbs.py", "render", self.video, env=env, cwd=self.tmp)
        last = json.loads(self.log.read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(last["slots"], ["slot-0"])

    def test_doctor_reports_without_failing_on_missing_speech_package(self):
        r = self.ve("doctor", check=False)
        self.assertIn("ffmpeg", r.stdout)
        self.assertIn("result:", r.stdout)
        self.assertIn("cores 4 jobs 2 ffmpeg threads 2", r.stdout)

    def test_a_missing_video_folder_is_a_clear_error(self):
        r = self.ve("prep", self.tmp / "nope", check=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no such video folder", r.stderr)


class NoWindowsOrMacOnlyCodeTest(common.Case):
    def test_no_shell_strings_and_no_mac_only_calls(self):
        bad = []
        needles = ("shell=True", "os.system(", "os.popen(", "afplay", "osascript", "caffeinate", "vm_stat", "fcntl",
                   "/dev/null", "sips ", "\"open\",", "'open',", "/opt/homebrew", "os.symlink", "symlink_to(")
        for p in common.KIT.rglob("*.py"):
            for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
                if any(x in line for x in needles) and "link_shared" not in line:
                    bad.append(f"{p.relative_to(common.KIT)}:{n}: {line.strip()[:80]}")
        # the one allowed symlink is the render work copy's `shared` link, with its fallbacks (gfx.link_shared)
        self.assertEqual([b for b in bad if not b.startswith("vekit/gfx.py")], [])


if __name__ == "__main__":
    unittest.main()
