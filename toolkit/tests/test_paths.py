import os
import unittest
from pathlib import Path

import common
from vekit import paths


class PathsTest(common.Case):
    def test_toolkit_is_found_from_the_code_location(self):
        self.assertEqual(paths.KIT, common.KIT)
        self.assertTrue((paths.TEMPLATES / "hit" / "index.html").exists())
        self.assertTrue((paths.SHARED).is_dir())
        self.assertTrue(paths.DTD.exists())

    def test_relative_video_folder_is_made_absolute_against_cwd(self):
        old = os.getcwd()
        self.addCleanup(os.chdir, old)
        os.chdir(self.tmp)
        here = Path(os.getcwd())                    # the system may spell the temp folder differently
        d = paths.video_dir("Chan/Video one")
        self.assertTrue(d.is_absolute())
        self.assertEqual(d, here / "Chan" / "Video one")
        self.assertEqual(paths.video_dir("Chan/../Chan/V"), here / "Chan" / "V")

    def test_spaces_and_non_ascii(self):
        v = self.tmp / "Chan nel" / "Vidéo काम 1"
        v.mkdir(parents=True)
        self.assertEqual(paths.video_dir(v), v)
        self.assertEqual(paths.project_dir(v), v / "CLAUDE_VE")
        self.assertEqual(paths.channel_dir(v), v.parent)

    def test_channel_dir_override(self):
        self.env(VE_CHANNEL_DIR=str(self.tmp / "elsewhere"))
        self.assertEqual(paths.channel_dir(self.tmp / "a" / "b"), self.tmp / "elsewhere")

    def test_stored_paths_round_trip(self):
        v = self.tmp / "Video 1"
        media = v / "broll" / "clip one.mp4"
        self.assertEqual(paths.rel(media, v), "broll/clip one.mp4")
        self.assertEqual(paths.resolve("broll/clip one.mp4", v), media)
        sfx = paths.SFX / "whoosh1.wav"
        self.assertEqual(paths.rel(sfx, v), "@kit/sfx/whoosh1.wav")
        self.assertEqual(paths.resolve("@kit/sfx/whoosh1.wav", v), sfx)
        other = self.tmp / "elsewhere" / "x.mp4"
        stored = paths.rel(other, v)
        self.assertTrue(paths.is_absolute(stored))
        self.assertEqual(paths.resolve(stored, v), other)

    def test_moving_the_video_folder_keeps_the_stored_paths_valid(self):
        a, b = self.tmp / "A", self.tmp / "B folder"
        s = paths.rel(a / "Main.mp4", a)
        self.assertEqual(paths.resolve(s, b), b / "Main.mp4")

    def test_windows_style_stored_paths_count_as_absolute(self):
        self.assertTrue(paths.is_absolute("C:/media/other.mp4"))
        self.assertTrue(paths.is_absolute("C:\\media\\other.mp4"))
        self.assertTrue(paths.is_absolute("//server/share/x.mp4"))
        self.assertFalse(paths.is_absolute("broll/x.mp4"))
        self.assertFalse(paths.is_absolute("@kit/sfx/x.wav"))

    def test_the_toolkit_ships_no_symlinks_and_no_machine_paths(self):
        links = [p for p in common.TOOLKIT.rglob("*") if p.is_symlink()]
        self.assertEqual(links, [])
        offenders = []
        for p in common.KIT.rglob("*.py"):
            text = p.read_text(encoding="utf-8")
            for bad in ("/Users/admin", "/opt/homebrew", "fcntl", "vm_stat", "/System/Library"):
                if bad in text:
                    offenders.append((p.name, bad))
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
