import io
import os
import subprocess
import sys
import types
import unittest
from unittest import mock

import common
from vekit import asr


def fake_mlx(calls):
    mod = types.ModuleType("mlx_whisper")

    def transcribe(audio, **kw):
        calls.append((audio, kw))
        return {"segments": [
            {"start": 0.0, "end": 1.5, "text": " hello there ",
             "words": [{"word": " hello", "start": 0.1, "end": 0.6, "probability": 0.91},
                       {"word": " there", "start": 0.7, "end": 1.4, "probability": 0.5}]},
            {"start": 2.0, "end": 3.0, "text": " bye", "words": [{"word": " bye", "start": 2.1, "end": 2.9}]}]}
    mod.transcribe = transcribe
    return mod


def fake_faster(calls, built):
    mod = types.ModuleType("faster_whisper")

    class Word:
        def __init__(self, w, s, e, p):
            self.word, self.start, self.end, self.probability = w, s, e, p

    class Seg:
        def __init__(self, s, e, text, words):
            self.start, self.end, self.text, self.words = s, e, text, words

    class WhisperModel:
        def __init__(self, name, **kw):
            built.append((name, kw))

        def transcribe(self, audio, **kw):
            calls.append((audio, kw))
            return iter([Seg(0.0, 1.5, " hello there ", [Word(" hello", 0.1, 0.6, 0.91), Word(" there", 0.7, 1.4, 0.5)]),
                         Seg(2.0, 3.0, " bye", [Word(" bye", 2.1, 2.9, None)])]), object()
    mod.WhisperModel = WhisperModel
    return mod


EXPECTED = {
    "text": "hello there bye",
    "segments": [{"s": 0.0, "e": 1.5, "text": "hello there"}, {"s": 2.0, "e": 3.0, "text": "bye"}],
    "words": [{"w": "hello", "s": 0.1, "e": 0.6, "p": 0.91}, {"w": "there", "s": 0.7, "e": 1.4, "p": 0.5},
              {"w": "bye", "s": 2.1, "e": 2.9, "p": 0.0}],
}


class AsrTest(common.Case):
    def setUp(self):
        super().setUp()
        asr.reset()
        self.addCleanup(asr.reset)

    def with_modules(self, **mods):
        p = mock.patch.dict(sys.modules, mods)
        p.start()
        self.addCleanup(p.stop)

    def test_backend_choice(self):
        with mock.patch.object(sys, "platform", "darwin"), mock.patch("platform.machine", return_value="arm64"):
            self.assertEqual(asr.backend(), "mlx")
        with mock.patch.object(sys, "platform", "darwin"), mock.patch("platform.machine", return_value="x86_64"):
            self.assertEqual(asr.backend(), "faster")
        with mock.patch.object(sys, "platform", "win32"), mock.patch("platform.machine", return_value="AMD64"):
            self.assertEqual(asr.backend(), "faster")
        with mock.patch.object(sys, "platform", "linux"), mock.patch("platform.machine", return_value="aarch64"):
            self.assertEqual(asr.backend(), "faster")
        self.env(VE_ASR_BACKEND="mlx")
        self.assertEqual(asr.backend(), "mlx")

    def test_model_names(self):
        self.assertEqual(asr.model_name("large-v3", "mlx"), "mlx-community/whisper-large-v3-mlx")
        self.assertEqual(asr.model_name("large-v3", "faster"), "large-v3")
        self.assertEqual(asr.model_name("turbo", "faster"), "large-v3-turbo")
        with self.assertRaises(ValueError):
            asr.model_name("tiny")

    def test_mlx_result_shape_options_and_offset(self):
        calls = []
        self.with_modules(mlx_whisper=fake_mlx(calls))
        self.env(VE_ASR_BACKEND="mlx")
        got = asr.transcribe(self.tmp / "a.wav", model="large-v3", language="hi", prompt="नमस्ते")
        self.assertEqual(got, EXPECTED)
        audio, kw = calls[0]
        self.assertEqual(audio, str(self.tmp / "a.wav"))
        self.assertEqual(kw["path_or_hf_repo"], "mlx-community/whisper-large-v3-mlx")
        self.assertEqual((kw["temperature"], kw["condition_on_previous_text"], kw["word_timestamps"]), (0.0, False, True))
        self.assertEqual((kw["language"], kw["initial_prompt"]), ("hi", "नमस्ते"))
        shifted = asr.transcribe("x.wav", offset=10.0)
        self.assertEqual(shifted["segments"][1], {"s": 12.0, "e": 13.0, "text": "bye"})
        self.assertEqual(shifted["words"][0]["s"], 10.1)

    def test_faster_whisper_gives_the_same_result(self):
        calls, built = [], []
        self.with_modules(faster_whisper=fake_faster(calls, built))
        self.env(VE_ASR_BACKEND="faster", VE_ASR_DEVICE="cpu", VE_CPU_CORES="3")
        got = asr.transcribe("x.wav", model="turbo", language="en")
        self.assertEqual(got, EXPECTED)
        audio, kw = calls[0]
        self.assertEqual((kw["temperature"], kw["condition_on_previous_text"], kw["word_timestamps"]), (0.0, False, True))
        self.assertEqual(kw["language"], "en")
        name, mk = built[0]
        self.assertEqual(name, "large-v3-turbo")
        self.assertEqual((mk["device"], mk["compute_type"], mk["cpu_threads"]), ("cpu", "int8", 3))
        self.assertEqual(asr.transcribe("x.wav", offset=1.0)["words"][2]["e"], 3.9)

    def test_both_backends_agree_on_numpy_input_and_the_model_loads_once(self):
        import numpy as np
        calls, built = [], []
        self.with_modules(faster_whisper=fake_faster(calls, built))
        self.env(VE_ASR_BACKEND="faster", VE_ASR_DEVICE="cpu")
        samples = np.zeros(1600, dtype="float32")
        asr.transcribe(samples)
        asr.transcribe(samples, offset=5)
        self.assertIs(calls[0][0], samples)
        self.assertEqual(len(built), 1)

    def test_cuda_when_requested(self):
        calls, built = [], []
        self.with_modules(faster_whisper=fake_faster(calls, built))
        self.env(VE_ASR_BACKEND="faster", VE_ASR_DEVICE="cuda")
        asr.transcribe("x.wav")
        self.assertEqual((built[0][1]["device"], built[0][1]["compute_type"]), ("cuda", "float16"))
        self.assertEqual(asr.device(), "gpu")

    def test_gpu_task_is_a_slot_only_on_the_gpu(self):
        slots = self.tmp / "slots"
        slots.mkdir()
        (slots / "limits.json").write_text('{"total":1,"perJob":1}')
        self.env(VE_GPU_SLOTS_DIR=str(slots), VE_JOB_ID="j", VE_ASR_BACKEND="faster", VE_ASR_DEVICE="cpu")
        with asr.gpu_task():
            self.assertEqual(list(slots.glob("slot-*")), [])
        self.env(VE_ASR_DEVICE="cuda")
        with asr.gpu_task():
            self.assertEqual([p.name for p in slots.glob("slot-*")], ["slot-0"])
        self.env(VE_ASR_BACKEND="mlx")
        self.assertEqual(asr.device(), "gpu")

    def test_importing_the_module_imports_no_speech_package(self):
        code = ("import sys; sys.path.insert(0, %r); import vekit.asr, vekit.resources; "
                "bad = [m for m in ('mlx_whisper', 'mlx', 'faster_whisper', 'ctranslate2', 'numpy') if m in sys.modules]; "
                "print(bad)" % str(common.KIT))
        out = subprocess.run([sys.executable, "-B", "-c", code], capture_output=True, text=True,
                             env=common.clean_env(), timeout=60)
        self.assertEqual(out.stdout.strip(), "[]", out.stderr)

    def test_detect_language_faster_averages_the_windows(self):
        import numpy as np
        probs = iter([[("hi", 0.9), ("en", 0.1)], [("hi", 0.5), ("en", 0.4), ("ur", 0.1)],
                      [("en", 0.2), ("hi", 0.7), ("ur", 0.1)]])
        seen = []
        mod = types.ModuleType("faster_whisper")

        class WhisperModel:
            def __init__(self, name, **kw):
                pass

            def detect_language(self, audio):
                seen.append(len(audio))
                return "x", 0.0, next(probs)
        mod.WhisperModel = WhisperModel
        self.with_modules(faster_whisper=mod)
        self.env(VE_ASR_BACKEND="faster", VE_ASR_DEVICE="cpu")
        audio = np.full(100 * 16000, 0.1, dtype="float32")
        got = asr.detect_language(audio)
        self.assertEqual(seen, [480000] * 3)
        self.assertEqual(got["language"], "hi")
        self.assertEqual(got["probability"], 0.7)
        self.assertEqual(got["top"], [("hi", 0.7), ("en", 0.233), ("ur", 0.067)])
        self.assertEqual(asr.describe_language(got), "language: hi 0.70 (en 0.23, ur 0.07)")

    def test_detect_language_mlx(self):
        import numpy as np
        calls = []
        core, pkg, audio_mod, tr_mod = (types.ModuleType(n) for n in (
            "mlx.core", "mlx_whisper", "mlx_whisper.audio", "mlx_whisper.transcribe"))
        core.float16 = "float16"
        audio_mod.N_FRAMES, audio_mod.N_SAMPLES = 3000, 480000

        class Mel:
            def astype(self, dtype):
                return self

        audio_mod.log_mel_spectrogram = lambda w, n_mels, padding: calls.append(("mel", len(w), n_mels, padding)) or Mel()
        audio_mod.pad_or_trim = lambda mel, n, axis: mel

        class Model:
            class dims:
                n_mels = 128

            def detect_language(self, mel):
                return None, {"hi": 0.2, "en": 0.75, "ur": 0.05}

        class ModelHolder:
            @staticmethod
            def get_model(name, dtype):
                calls.append(("model", name, dtype))
                return Model()
        tr_mod.ModelHolder = ModelHolder
        mlx = types.ModuleType("mlx")
        mlx.core = core
        pkg.audio, pkg.transcribe = audio_mod, tr_mod
        self.with_modules(**{"mlx": mlx, "mlx.core": core, "mlx_whisper": pkg, "mlx_whisper.audio": audio_mod,
                             "mlx_whisper.transcribe": tr_mod})
        self.env(VE_ASR_BACKEND="mlx")
        got = asr.detect_language(np.full(16000 * 5, 0.1, dtype="float32"))
        self.assertEqual((got["language"], got["probability"]), ("en", 0.75))
        self.assertEqual(calls, [("model", "mlx-community/whisper-large-v3-mlx", "float16"),
                                 ("mel", 80000, 128, 480000)])

    def test_detection_windows_are_spread_and_skip_silence(self):
        import numpy as np
        size = 30 * 16000
        audio = np.full(150 * 16000, 0.1, dtype="float32")
        self.assertEqual(len(asr._detection_windows(audio[:size], 3)), 1)
        self.assertEqual(len(asr._detection_windows(audio[:size * 2], 3)), 2)
        self.assertEqual(len(asr._detection_windows(audio, 3)), 3)
        audio[:] = 0.0                          # only the middle is spoken: the silent windows are not listened to
        audio[60 * 16000:90 * 16000] = 0.1
        wins = asr._detection_windows(audio, 3)
        self.assertEqual(len(wins), 1)
        self.assertGreater(float(wins[0].max()), 0)
        silent = np.zeros(150 * 16000, dtype="float32")
        self.assertEqual(len(asr._detection_windows(silent, 3)), 3)


class GpuFaster:
    """A fake faster_whisper whose CUDA model can be made to fail the way a missing library does."""

    def __init__(self, fail_with=None):
        self.fail_with, self.built, self.calls = fail_with, [], []
        outer = self
        mod = types.ModuleType("faster_whisper")

        class Seg:
            start, end, text, words = 0.0, 1.0, " hi", []

        class WhisperModel:
            def __init__(self, name, **kw):
                self.device = kw["device"]
                outer.built.append((name, kw))

            def transcribe(self, audio, **kw):
                outer.calls.append((self.device, audio, kw))
                if self.device == "cuda" and outer.fail_with:
                    raise RuntimeError(outer.fail_with)
                return iter([Seg()]), object()
        mod.WhisperModel = WhisperModel
        self.module = mod


class CudaDecisionTest(common.Case):
    """The speech device: CUDA on an NVIDIA machine, never a quiet fall back to the CPU."""

    def setUp(self):
        super().setUp()
        asr.reset()
        self.addCleanup(asr.reset)
        self.env(VE_ASR_BACKEND="faster")
        self.nvidia, self.count, self.missing = None, 0, []
        for name, fn in (("nvidia_gpu_name", lambda: self.nvidia), ("_cuda_device_count", lambda: self.count),
                         ("missing_cuda_libraries", lambda: list(self.missing)),
                         ("register_cuda_libraries", lambda: [])):
            p = mock.patch.object(asr, name, side_effect=fn)
            p.start()
            self.addCleanup(p.stop)

    def fake(self, fail_with=None):
        f = GpuFaster(fail_with)
        p = mock.patch.dict(sys.modules, {"faster_whisper": f.module})
        p.start()
        self.addCleanup(p.stop)
        return f

    def test_no_nvidia_gpu_means_cpu_without_a_problem(self):
        f = self.fake()
        self.assertEqual((asr.device(), asr.describe()["problem"]), ("cpu", None))
        self.assertEqual(asr.describe()["summary"], "CPU (no NVIDIA GPU)")
        asr.transcribe("x.wav")
        self.assertEqual(f.built[0][1]["device"], "cpu")

    def test_the_cpu_can_be_asked_for_on_an_nvidia_machine(self):
        self.nvidia, self.count, self.missing = "NVIDIA GeForce RTX 5060 Ti", 1, ["cublas64_12.dll"]
        self.env(VE_ASR_DEVICE="cpu")
        f = self.fake()
        asr.transcribe("x.wav")
        self.assertEqual((asr.device(), f.built[0][1]["device"]), ("cpu", "cpu"))

    def test_working_cuda_is_proven_once_with_one_second_of_silence(self):
        self.nvidia, self.count = "NVIDIA GeForce RTX 5060 Ti", 1
        f = self.fake()
        asr.transcribe("x.wav")
        asr.transcribe("y.wav")
        self.assertEqual([b[1]["device"] for b in f.built], ["cuda"])
        self.assertEqual(f.built[0][1]["compute_type"], "float16")
        self.assertEqual(len(f.calls), 3)                        # the proof, then the two runs
        self.assertEqual((len(f.calls[0][1]), f.calls[1][1]), (16000, "x.wav"))
        self.assertEqual(asr.describe()["summary"], "GPU (CUDA) (NVIDIA GeForce RTX 5060 Ti)")
        self.assertIsNone(asr.describe()["problem"])

    def test_missing_libraries_stop_the_run_with_one_line_and_never_use_the_cpu(self):
        self.nvidia, self.count = "NVIDIA GeForce RTX 5060 Ti", 1
        self.missing = ["cublas64_12.dll", "cudnn64_9.dll"]
        f = self.fake()
        self.assertEqual(asr.device(), "gpu")
        info = asr.describe()
        self.assertIn("cublas64_12.dll, cudnn64_9.dll", info["problem"])
        self.assertIn("Prepare", info["problem"])
        with self.assertRaises(asr.SpeechDeviceError) as cm:
            asr.transcribe("x.wav")
        line = str(cm.exception)
        self.assertNotIn("\n", line)
        self.assertIn("cublas64_12.dll", line)
        self.assertIn("Prepare", line)
        self.assertIn("not used instead", line)
        self.assertEqual(f.built, [])                              # nothing loaded, nothing on the CPU

    def test_a_driver_without_a_cuda_device_is_a_problem_not_a_cpu_run(self):
        self.nvidia, self.count = "NVIDIA GeForce RTX 5060 Ti", 0
        f = self.fake()
        self.assertIn("no CUDA device", asr.describe()["problem"])
        with self.assertRaises(asr.SpeechDeviceError):
            asr.transcribe("x.wav")
        self.assertEqual(f.built, [])

    def test_a_cuda_failure_at_the_first_run_names_the_library(self):
        self.nvidia, self.count = "NVIDIA GeForce RTX 5060 Ti", 1
        f = self.fake("Library cublas64_12.dll is not found or cannot be loaded")
        with self.assertRaises(asr.SpeechDeviceError) as cm:
            asr.transcribe("x.wav")
        self.assertIn("library cublas64_12.dll is missing or too old", str(cm.exception))
        self.assertEqual([b[1]["device"] for b in f.built], ["cuda"])    # no CPU model was built
        with self.assertRaises(asr.SpeechDeviceError):
            asr.transcribe("x.wav")

    def test_forced_cuda_that_fails_stops_too(self):
        self.env(VE_ASR_DEVICE="cuda")
        f = self.fake("CUDA failed with error no kernel image is available for execution on the device")
        with self.assertRaises(asr.SpeechDeviceError) as cm:
            asr.transcribe("x.wav")
        self.assertIn("no kernel image", str(cm.exception))
        self.assertEqual([b[1]["device"] for b in f.built], ["cuda"])

    def test_warm_up_proves_the_gpu_and_leaves_the_cpu_alone(self):
        self.nvidia, self.count = "NVIDIA GeForce RTX 5060 Ti", 1
        f = self.fake()
        self.assertIn("GPU (CUDA)", asr.warm_up("turbo"))
        self.assertEqual(f.built[0][0], "large-v3-turbo")
        asr.reset()
        self.nvidia, self.count = None, 0
        f2 = self.fake()
        self.assertEqual(asr.warm_up(), "CPU (no NVIDIA GPU)")
        self.assertEqual(f2.built, [])

    def test_guarded_prints_the_line_and_exits_2(self):
        def boom():
            raise asr.SpeechDeviceError("speech: one line")
        err = io.StringIO()
        with mock.patch.object(sys, "stderr", err):
            self.assertEqual(asr.guarded(boom), 2)
        self.assertEqual(err.getvalue(), "speech: one line\n")
        self.assertEqual(asr.guarded(lambda: 0), 0)


class CudaLibraryTest(common.Case):
    """Finding the CUDA libraries the pip wheels carry."""

    def setUp(self):
        super().setUp()
        asr.reset()
        self.addCleanup(asr.reset)
        self.site = self.tmp / "site"
        for lib, sub, names in (("cublas", "bin", ["cublas64_12.dll", "cublasLt64_12.dll"]),
                                ("cudnn", "bin", ["cudnn64_9.dll", "cudnn_ops64_9.dll", "cudnn_cnn64_9.dll"]),
                                ("cublas", "lib", ["libcublas.so.12"])):
            d = self.site / "nvidia" / lib / sub
            d.mkdir(parents=True, exist_ok=True)
            for n in names:
                (d / n).write_bytes(b"")
        p = mock.patch.object(sys, "path", [str(self.site), str(self.tmp / "none")])
        p.start()
        self.addCleanup(p.stop)

    def test_the_wheel_folders_are_bin_on_windows_and_lib_elsewhere(self):
        with mock.patch.object(asr, "_is_windows", return_value=True):
            self.assertEqual([p.parts[-2:] for p in asr.nvidia_library_dirs()],
                             [("cublas", "bin"), ("cudnn", "bin")])
        with mock.patch.object(asr, "_is_windows", return_value=False):
            self.assertEqual([p.parts[-2:] for p in asr.nvidia_library_dirs()], [("cublas", "lib")])

    def test_windows_registers_the_dll_folders_and_puts_them_first_in_path(self):
        added = []
        with mock.patch.object(asr, "_is_windows", return_value=True), \
                mock.patch.object(os, "add_dll_directory", create=True, side_effect=lambda d: added.append(d)):
            dirs = asr.register_cuda_libraries()
            again = asr.register_cuda_libraries()
        self.assertIs(dirs, again)
        self.assertEqual(added, [str(d) for d in dirs])
        path = os.environ["PATH"].split(os.pathsep)
        self.assertEqual(path[:2], [str(d) for d in dirs])

    def test_missing_libraries_are_the_dlls_not_on_path(self):
        with mock.patch.object(asr, "_is_windows", return_value=True):
            self.assertEqual(len(asr.missing_cuda_libraries()), 5)
            asr.register_cuda_libraries()
            self.assertEqual(asr.missing_cuda_libraries(), [])
            (self.site / "nvidia" / "cudnn" / "bin" / "cudnn_ops64_9.dll").unlink()
            self.assertEqual(asr.missing_cuda_libraries(), ["cudnn_ops64_9.dll"])

    def test_nvidia_smi_gives_the_gpu_name(self):
        done = types.SimpleNamespace(returncode=0, stdout="NVIDIA GeForce RTX 5060 Ti\n")
        with mock.patch("shutil.which", return_value="/usr/bin/nvidia-smi"), \
                mock.patch("subprocess.run", return_value=done):
            self.assertEqual(asr.nvidia_gpu_name(), "NVIDIA GeForce RTX 5060 Ti")
        with mock.patch("shutil.which", return_value="/usr/bin/nvidia-smi"), \
                mock.patch("subprocess.run", return_value=types.SimpleNamespace(returncode=9, stdout="")):
            self.assertIsNone(asr.nvidia_gpu_name())
        with mock.patch.object(asr, "_is_windows", return_value=False), mock.patch("shutil.which", return_value=None):
            self.assertIsNone(asr.nvidia_gpu_name())


class TranscribeScriptTest(common.Case):
    """transcribe.py and windows.py talk to the speech package only through vekit.asr."""

    def test_no_other_module_imports_a_speech_package(self):
        bad = []
        for p in common.KIT.rglob("*.py"):
            if p.name == "asr.py":
                continue
            for line in p.read_text(encoding="utf-8").splitlines():
                if line.strip().startswith(("import mlx", "from mlx", "import faster_whisper", "from faster_whisper",
                                            "import ctranslate2")):
                    bad.append(f"{p.name}: {line.strip()}")
        self.assertEqual(bad, [])

    @unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_transcribe_script_with_a_fake_backend(self):
        wav = self.tmp / "a_16k.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=300:d=2:r=16000", "-ac", "1",
                        str(wav)], check=True, stdin=subprocess.DEVNULL)
        fake = self.tmp / "fakes"
        fake.mkdir()
        (fake / "faster_whisper.py").write_text(
            "class _W:\n"
            "    def __init__(s, w, st, e, p): s.word, s.start, s.end, s.probability = w, st, e, p\n"
            "class _S:\n"
            "    def __init__(s, a, b, t, w): s.start, s.end, s.text, s.words = a, b, t, w\n"
            "class WhisperModel:\n"
            "    def __init__(self, *a, **k): pass\n"
            "    def transcribe(self, audio, **k):\n"
            "        return iter([_S(0.0, 1.0, ' नमस्ते दुनिया', [_W(' नमस्ते', 0.0, 0.4, 0.9), _W(' दुनिया', 0.5, 0.9, 0.8)])]), None\n",
            encoding="utf-8")
        out = self.tmp / "tr"
        env = common.clean_env(VE_ASR_BACKEND="faster", VE_ASR_DEVICE="cpu", PYTHONPATH=str(fake),
                               PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="ascii")
        r = subprocess.run([sys.executable, str(common.KIT / "transcribe.py"), str(wav), str(out), "a1",
                            "--pass", "full"], env=env, capture_output=True, text=True, encoding="utf-8", timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        import json
        full = json.loads((out / "a1.full.json").read_text(encoding="utf-8"))
        self.assertEqual([w["w"] for w in full["words"]], ["नमस्ते", "दुनिया"])

    FAKE_DETECTING_FASTER = (
        "import os, sys\n"
        "class _W:\n"
        "    def __init__(s, w, st, e, p): s.word, s.start, s.end, s.probability = w, st, e, p\n"
        "class _S:\n"
        "    def __init__(s, a, b, t, w): s.start, s.end, s.text, s.words = a, b, t, w\n"
        "class WhisperModel:\n"
        "    def __init__(self, *a, **k): pass\n"
        "    def detect_language(self, audio):\n"
        "        if os.environ.get('FAKE_NO_DETECT'): raise SystemExit('detect_language must not run')\n"
        "        lang = os.environ.get('FAKE_LANG', 'hi')\n"
        "        return lang, 0.9, [(lang, 0.9), ('ur', 0.1)]\n"
        "    def transcribe(self, audio, **k):\n"
        "        t = ' %s %s' % (k['language'], 'prompted' if k.get('initial_prompt') else 'plain')\n"
        "        return iter([_S(0.0, 1.0, t, [_W(t, 0.0, 0.4, 0.9)])]), None\n")

    def run_script(self, args, **env):
        fake = self.tmp / "fakes"
        fake.mkdir(exist_ok=True)
        (fake / "faster_whisper.py").write_text(self.FAKE_DETECTING_FASTER, encoding="utf-8")
        e = common.clean_env(VE_ASR_BACKEND="faster", VE_ASR_DEVICE="cpu", PYTHONPATH=str(fake),
                             PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8", **env)
        return subprocess.run([sys.executable] + [str(a) for a in args], env=e, capture_output=True, text=True,
                              encoding="utf-8", timeout=120)

    def tone(self, name="a_16k.wav"):
        wav = self.tmp / name
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=300:d=2:r=16000", "-ac", "1",
                        str(wav)], check=True, stdin=subprocess.DEVNULL)
        return wav

    @unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_lang_auto_detects_once_and_the_hindi_prompt_follows_the_language(self):
        import json
        wav = self.tone()
        r = self.run_script([common.KIT / "transcribe.py", wav, self.tmp / "en", "a1", "--pass", "full", "--lang", "auto"],
                            FAKE_LANG="en")
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        self.assertIn("language: en 0.90 (ur 0.10)", r.stdout)
        full = json.loads((self.tmp / "en" / "a1.full.json").read_text(encoding="utf-8"))
        self.assertEqual((full["language"], full["words"][0]["w"]), ("en", "en plain"))
        r = self.run_script([common.KIT / "transcribe.py", wav, self.tmp / "hi", "a1", "--pass", "chunks", "--lang", "auto"])
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        chunks = json.loads((self.tmp / "hi" / "a1.chunks.json").read_text(encoding="utf-8"))
        self.assertEqual(chunks["language"], "hi")
        self.assertIn("hi prompted", chunks["chunks"][0]["text"])

    @unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_an_explicit_language_is_not_detected(self):
        import json
        wav = self.tone()
        r = self.run_script([common.KIT / "transcribe.py", wav, self.tmp / "o", "a1", "--pass", "full", "--lang", "en"],
                            FAKE_NO_DETECT="1", FAKE_LANG="hi")
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        self.assertNotIn("language:", r.stdout)
        full = json.loads((self.tmp / "o" / "a1.full.json").read_text(encoding="utf-8"))
        self.assertEqual(full["words"][0]["w"], "en plain")
        r = self.run_script([common.KIT / "windows.py", wav, self.tmp / "w.json", "0-1.5", "--lang", "hi"],
                            FAKE_NO_DETECT="1")
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        self.assertIn("hi prompted", r.stdout)

    @unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_windows_lang_auto(self):
        import json
        wav = self.tone()
        r = self.run_script([common.KIT / "windows.py", wav, self.tmp / "w.json", "0-1.5", "--lang", "auto"],
                            FAKE_LANG="en")
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        self.assertIn("language: en 0.90", r.stdout)
        out = json.loads((self.tmp / "w.json").read_text(encoding="utf-8"))
        self.assertEqual((out["language"], out["pieces"][0]["text"]), ("en", "en plain"))

    @unittest.skipUnless(common.have_ffmpeg(), "needs ffmpeg")
    def test_ve_lang_prints_the_language_of_each_aroll(self):
        main = self.tmp / "Video one"
        audio = main / "CLAUDE_VE" / "audio"
        audio.mkdir(parents=True)
        (main / "CLAUDE_VE" / "project.json").write_text('{"aroll": {"a1": "Main.mp4"}}', encoding="utf-8")
        (audio / "a1_16k.wav").write_bytes(self.tone().read_bytes())
        r = self.run_script([common.KIT / "ve.py", "lang", main], FAKE_LANG="en")
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        self.assertEqual(r.stdout.strip(), "a1  language: en 0.90 (ur 0.10)")
        r = self.run_script([common.KIT / "ve.py", "lang", self.tmp / "none"])
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("ve.py prep", r.stderr)


if __name__ == "__main__":
    unittest.main()
