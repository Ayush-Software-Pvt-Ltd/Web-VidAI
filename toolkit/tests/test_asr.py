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
        asr._faster_models.clear()
        self.addCleanup(asr._faster_models.clear)

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


if __name__ == "__main__":
    unittest.main()
