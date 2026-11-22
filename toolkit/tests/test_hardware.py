import unittest
from unittest import mock

import common
from vekit import resources


def data(name):
    return (common.DATA / name).read_text(encoding="utf-8")


class Machine:
    """A pretend ffmpeg: its lists come from recorded files, `works` says which encoders start."""

    def __init__(self, case, encoders, hwaccels, works):
        self.tried = []
        self.works = set(works)
        for target, value in (("_encoders_text", data(encoders)), ("_hwaccels_text", data(hwaccels))):
            p = mock.patch.object(resources, target, return_value=value)
            p.start()
            case.addCleanup(p.stop)
        p = mock.patch.object(resources, "_probe_encoder", side_effect=self.probe)
        p.start()
        case.addCleanup(p.stop)
        resources.reset_cache()

    def probe(self, name):
        self.tried.append(name)
        return name in self.works


class ParseTest(common.Case):
    def test_recorded_lists(self):
        mac = resources.parse_encoders(data("encoders-macos.txt"))
        self.assertTrue({"h264_videotoolbox", "hevc_videotoolbox", "prores_videotoolbox", "libx264",
                         "libx265", "prores_ks", "aac", "aac_at"} <= mac)
        self.assertNotIn("Video", mac)
        win = resources.parse_encoders(data("encoders-windows.txt"))
        self.assertTrue({"h264_nvenc", "h264_qsv", "h264_amf", "hevc_nvenc", "libx264", "aac"} <= win)
        self.assertFalse(any("videotoolbox" in n for n in win))
        self.assertEqual(resources.parse_encoders(""), set())


class MacTest(common.Case):
    def setUp(self):
        super().setUp()
        self.m = Machine(self, "encoders-macos.txt", "hwaccels-macos.txt",
                         {"h264_videotoolbox", "hevc_videotoolbox", "prores_videotoolbox"})

    def test_videotoolbox_is_chosen_for_everything(self):
        for kind in ("h264", "hevc", "prores"):
            self.assertEqual(resources.backend(kind), "videotoolbox")
        self.assertEqual(resources.video_encoder_name("prores"), "prores_videotoolbox")
        self.assertEqual(resources.hwaccel_args(), ["-hwaccel", "videotoolbox"])
        self.assertTrue(resources.uses_gpu("h264"))
        self.assertTrue(resources.is_loose_rate())
        self.assertEqual(resources.audio_encoder("256k"), ["-c:a", "aac_at", "-aac_at_mode", "cbr", "-b:a", "256k"])

    def test_the_arguments_of_the_old_mac_toolkit_are_kept(self):
        self.assertEqual(resources.video_encoder("prores", profile="hq"),
                         ["-c:v", "prores_videotoolbox", "-profile:v", "hq"])
        hevc = resources.video_encoder("hevc", bitrate="50M", gop=24)
        self.assertEqual(hevc, ["-c:v", "hevc_videotoolbox", "-profile:v", "main10", "-tag:v", "hvc1",
                                "-allow_sw", "0", "-b:v", "50M", "-g", "24"])
        h264 = resources.video_encoder("h264", quality=60)
        self.assertEqual(h264[:4], ["-c:v", "h264_videotoolbox", "-profile:v", "high"])
        self.assertIn("-q:v", h264)
        self.assertEqual(resources.pix_fmt("h264"), "nv12")
        self.assertEqual(resources.pix_fmt("hevc"), "p010le")

    def test_ve_hw_none_forces_software_everywhere(self):
        self.env(VE_HW="none")
        resources.reset_cache()
        self.assertEqual(resources.backend("h264"), "software")
        self.assertEqual(resources.video_encoder("prores")[:2], ["-c:v", "prores_ks"])
        self.assertEqual(resources.hwaccel_args(), [])
        self.assertEqual(resources.audio_encoder()[:2], ["-c:a", "aac"])
        self.assertFalse(resources.uses_gpu("h264", "hevc", "prores"))
        self.assertFalse(resources.is_loose_rate())
        self.assertEqual(self.m.tried, [])                        # nothing was even tried

    def test_a_backend_the_machine_lacks_falls_back_to_software(self):
        self.env(VE_HW="nvenc")
        resources.reset_cache()
        self.assertEqual(resources.backend("h264"), "software")

    def test_software_arguments(self):
        self.env(VE_HW="none")
        resources.reset_cache()
        h = resources.video_encoder("h264", bitrate="40M")
        self.assertEqual(h[:4], ["-c:v", "libx264", "-profile:v", "high"])
        self.assertEqual(h[h.index("-b:v") + 1], "40M")
        self.assertEqual(h[h.index("-maxrate") + 1], "40M")
        self.assertEqual(h[h.index("-bufsize") + 1], "80M")
        self.assertEqual(resources.pix_fmt("h264"), "yuv420p")
        x = resources.video_encoder("hevc", bitrate="50M", gop=24)
        self.assertEqual(x[:2], ["-c:v", "libx265"])
        self.assertIn("hvc1", x)
        self.assertNotIn("-allow_sw", x)
        self.assertEqual(resources.pix_fmt("hevc"), "yuv420p10le")

    def test_results_are_cached(self):
        resources.backend("h264")
        n = len(self.m.tried)
        resources.backend("h264")
        resources.video_encoder("h264")
        self.assertEqual(len(self.m.tried), n)


class WindowsTest(common.Case):
    def test_listed_but_absent_hardware_is_not_chosen(self):
        # a Windows ffmpeg lists NVENC, QSV and AMF on every computer
        m = Machine(self, "encoders-windows.txt", "hwaccels-windows.txt", set())
        self.assertEqual(resources.backend("h264"), "software")
        self.assertEqual(resources.video_encoder_name("h264"), "libx264")
        self.assertEqual(resources.hwaccel_args(), [])
        self.assertIn("h264_nvenc", m.tried)
        self.assertEqual(resources.audio_encoder_name(), "aac")

    def test_nvidia_card(self):
        Machine(self, "encoders-windows.txt", "hwaccels-windows.txt", {"h264_nvenc", "hevc_nvenc"})
        self.assertEqual(resources.backend("h264"), "nvenc")
        self.assertEqual(resources.backend("hevc"), "nvenc")
        self.assertEqual(resources.backend("prores"), "software")     # ProRes only has a Mac hardware encoder
        self.assertEqual(resources.hwaccel_args(), ["-hwaccel", "cuda"])
        a = resources.video_encoder("h264", bitrate="40M")
        self.assertEqual(a[:2], ["-c:v", "h264_nvenc"])
        self.assertIn("-rc", a)
        self.assertFalse(resources.is_loose_rate())
        self.assertTrue(resources.uses_gpu("prores"))                 # hardware decoding still uses the GPU

    def test_intel_graphics_when_nvidia_is_absent(self):
        Machine(self, "encoders-windows.txt", "hwaccels-windows.txt", {"h264_qsv", "hevc_qsv"})
        self.assertEqual(resources.backend("h264"), "qsv")
        self.assertEqual(resources.hwaccel_args(), ["-hwaccel", "qsv"])
        self.assertEqual(resources.pix_fmt("h264"), "nv12")

    def test_forcing_one_backend_tries_only_that_one(self):
        m = Machine(self, "encoders-windows.txt", "hwaccels-windows.txt", {"h264_nvenc", "h264_amf"})
        self.env(VE_HW="amf")
        resources.reset_cache()
        self.assertEqual(resources.backend("h264"), "amf")
        self.assertEqual(m.tried, ["h264_amf"])


class NoFfmpegTest(common.Case):
    def test_without_ffmpeg_everything_is_software(self):
        self.env(VE_FFMPEG=str(self.tmp / "no such ffmpeg"))
        resources.reset_cache()
        self.assertEqual(resources.encoders(), set())
        self.assertEqual(resources.backend("h264"), "software")
        self.assertEqual(resources.hwaccel_args(), [])


@unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
class RealFfmpegTest(common.Case):
    def test_the_real_machine_gives_arguments_ffmpeg_accepts(self):
        import subprocess
        for kind, pix in (("h264", "yuv420p"), ("hevc", "yuv420p10le"), ("prores", "yuv422p10le")):
            args = resources.video_encoder(kind, **({"profile": "standard"} if kind == "prores" else {}))
            out = self.tmp / f"{kind}.mov"
            cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=256x144:r=24:d=0.5",
                   "-pix_fmt", resources.pix_fmt(kind) if kind != "prores" else "yuv422p10le"] + args + \
                  resources.ffmpeg_thread_args() + [str(out)]
            r = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL)
            self.assertEqual(r.returncode, 0, f"{kind}: {' '.join(cmd)}\n{r.stderr[-400:]}")

    def test_software_choice_encodes_too(self):
        import subprocess
        self.env(VE_HW="none")
        resources.reset_cache()
        for kind in ("h264", "hevc", "prores"):
            out = self.tmp / f"sw-{kind}.mov"
            cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=256x144:r=24:d=0.5",
                   "-pix_fmt", "yuv422p10le" if kind == "prores" else resources.pix_fmt(kind)] + \
                  resources.video_encoder(kind, bitrate="4M") + [str(out)]
            r = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL)
            self.assertEqual(r.returncode, 0, f"{kind}: {r.stderr[-300:]}")


if __name__ == "__main__":
    unittest.main()
