"""Windows locks in a render's work folder, and the rule that the toolkit renders at 720 or 1080 only."""
import os
import shutil
import unittest
from pathlib import Path
from unittest import mock

import common
from vekit import gfx, resources, scratch
from vekit.model import Rate

LOCKED = PermissionError(13, "The process cannot access the file because it is being used by another process")


def locked_rmtree(real=shutil.rmtree, fail_times=None):
    """A shutil.rmtree that raises like Windows while Chrome holds a file (WinError 32).
    `fail_times` None: always; a number: that many failures, then the real removal."""
    calls = {"n": 0}

    def fake(path, ignore_errors=False, **kw):
        calls["n"] += 1
        if fail_times is None or calls["n"] <= fail_times:
            if ignore_errors:
                return
            raise LOCKED
        real(path, ignore_errors=ignore_errors, **kw)
    fake.calls = calls
    return fake


class ScratchDir(common.Case):
    def test_removes_the_folder(self):
        with scratch.scratch_dir("t_") as d:
            (Path(d) / "a").write_text("x")
        self.assertFalse(Path(d).exists())

    def test_locked_folder_does_not_raise_and_is_retried(self):
        fake = locked_rmtree(fail_times=2)
        with mock.patch("vekit.scratch.shutil.rmtree", fake), mock.patch("vekit.scratch.time.sleep"):
            with scratch.scratch_dir("t_") as d:
                (Path(d) / "a").write_text("x")
        self.assertEqual(fake.calls["n"], 3)
        self.assertFalse(Path(d).exists())

    def test_stays_locked_still_does_not_raise(self):
        fake = locked_rmtree()
        with mock.patch("vekit.scratch.shutil.rmtree", fake), mock.patch("vekit.scratch.time.sleep"):
            with scratch.scratch_dir("t_") as d:
                (Path(d) / "a").write_text("x")
            self.assertTrue(Path(d).exists())
            self.assertFalse(scratch.remove_tree(d, sleep=lambda s: None))
        shutil.rmtree(d, ignore_errors=True)

    def test_the_real_error_is_not_hidden(self):
        with mock.patch("vekit.scratch.shutil.rmtree", locked_rmtree()), mock.patch("vekit.scratch.time.sleep"):
            with self.assertRaises(ValueError):
                with scratch.scratch_dir("t_"):
                    raise ValueError("render failed")


class RenderOneSurvivesCleanup(common.Case):
    def render(self):
        src = self.tmp / "src"
        src.mkdir()
        (src / "index.html").write_text("<html></html>", encoding="utf-8")
        pdir = self.tmp / "pdir"

        def fake_run(cmd, **kw):
            Path(cmd[cmd.index("-o") + 1]).write_bytes(b"mov")
            return mock.Mock(returncode=0, stdout="", stderr="")

        with mock.patch.object(gfx.subprocess, "run", fake_run), mock.patch.object(gfx, "link_shared"), \
                mock.patch.object(gfx, "files_hash", return_value="key1"), \
                mock.patch.object(gfx.tools, "hyperframes", return_value=["hf"]):
            return gfx.render_one("g1", src, None, 1080, "landscape-4k", Rate(30), pdir), pdir

    def test_key_is_written_although_the_work_folder_cannot_be_removed(self):
        with mock.patch("vekit.scratch.shutil.rmtree", locked_rmtree()), mock.patch("vekit.scratch.time.sleep"):
            result, pdir = self.render()
        self.assertEqual(result, ("g1", 1080, "rendered"))
        out = pdir / "gfx" / "1080" / "g1.mov"
        self.assertEqual(out.read_bytes(), b"mov")
        self.assertEqual(out.with_suffix(".key").read_text(encoding="utf-8"), "key1")

    def test_next_run_is_a_cache_hit(self):
        result, pdir = self.render()
        self.assertEqual(result[2], "rendered")
        with mock.patch.object(gfx, "files_hash", return_value="key1"):
            again = gfx.render_one("g1", self.tmp / "src", None, 1080, "landscape-4k", Rate(30), pdir)
        self.assertEqual(again[2], "cached")


class Resolution(common.Case):
    def test_720_and_1080_pass(self):
        self.assertEqual(resources.check_resolution("720"), 720)
        self.assertEqual(resources.check_resolution(1080), 1080)

    def test_2160_is_refused_with_one_line(self):
        with self.assertRaises(SystemExit) as e:
            resources.check_resolution("2160")
        self.assertIn("only for the final render", str(e.exception))
        self.assertNotIn("\n", str(e.exception))

    def test_other_values_are_refused(self):
        for bad in ("480", "abc", "4k"):
            with self.assertRaises(SystemExit):
                resources.check_resolution(bad)

    def test_the_administrator_override(self):
        self.env(VE_ALLOW_2160="1")
        self.assertEqual(resources.check_resolution("2160"), 2160)

    def test_gfx_render_all_refuses_2160(self):
        with self.assertRaises(SystemExit):
            gfx.render_all(None, self.tmp, [1080, 2160])


if __name__ == "__main__":
    unittest.main()
