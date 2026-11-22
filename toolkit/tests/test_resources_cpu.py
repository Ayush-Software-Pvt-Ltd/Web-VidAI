import os
import unittest
from unittest import mock

import common
from vekit import resources, tools


class CpuBudgetTest(common.Case):
    def cores(self, n):
        self.env(VE_CPU_CORES=str(n))

    def test_table(self):
        # cores -> (parallel ffmpeg jobs, threads each, HyperFrames workers, HyperFrames renders at once)
        table = {1: (1, 1, 1, 1), 2: (1, 2, 1, 2), 3: (1, 3, 1, 3), 4: (2, 2, 2, 2), 8: (4, 2, 4, 2),
                 16: (8, 2, 8, 2), 32: (8, 4, 16, 2), 64: (8, 8, 32, 2)}
        for n, want in table.items():
            self.cores(n)
            got = (resources.jobs(), resources.ffmpeg_threads(), resources.hf_workers(), resources.hf_jobs())
            self.assertEqual(got, want, f"{n} cores")
            self.assertLessEqual(resources.jobs() * resources.ffmpeg_threads(), n)
            self.assertLessEqual(resources.hf_workers() * resources.hf_jobs(), n)

    def test_without_the_variable_all_logical_processors_count(self):
        with mock.patch.object(os, "cpu_count", return_value=12):
            self.assertEqual(resources.cores(), 12)
        with mock.patch.object(os, "cpu_count", return_value=None):
            self.assertEqual(resources.cores(), 1)

    def test_bad_values_fall_back(self):
        for bad in ("", "abc", "0", "-3"):
            self.env(VE_CPU_CORES=bad)
            with mock.patch.object(os, "cpu_count", return_value=6):
                self.assertEqual(resources.cores(), 6, repr(bad))

    def test_thread_arguments_are_output_options_and_match_the_budget(self):
        self.cores(8)
        t = resources.ffmpeg_thread_args()
        self.assertEqual(t, ["-threads", "2", "-filter_threads", "2", "-filter_complex_threads", "2"])
        self.assertEqual(resources.decode_args()[-2:], ["-threads", "2"])

    def test_variable_is_read_at_every_call(self):
        self.cores(2)
        self.assertEqual(resources.cores(), 2)
        self.cores(10)
        self.assertEqual(resources.cores(), 10)


class ToolsTest(common.Case):
    def test_defaults_and_overrides(self):
        self.assertTrue(tools.ffmpeg().endswith("ffmpeg") or tools.ffmpeg().lower().endswith("ffmpeg.exe"))
        self.env(VE_FFMPEG=str(self.tmp / "my ffmpeg"), VE_FFPROBE="probe-x")
        self.assertEqual(tools.ffmpeg(), str(self.tmp / "my ffmpeg"))
        self.assertEqual(tools.ffprobe(), "probe-x")

    def test_no_hard_coded_program_paths_left(self):
        import re
        bad = []
        for p in common.KIT.rglob("*.py"):
            for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
                if re.search(r'\[\s*"(ffmpeg|ffprobe|npx|node)"', line):
                    bad.append(f"{p.name}:{n}")
        self.assertEqual(bad, [])

    def test_label_font_loads(self):
        f = tools.label_font(20)
        self.assertGreater(f.getlength("12.5"), 0)


if __name__ == "__main__":
    unittest.main()
