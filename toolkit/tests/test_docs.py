"""The agents' standing instructions must not mention what the toolkit no longer does."""
import re
import unittest
from pathlib import Path

TOOLKIT = Path(__file__).resolve().parents[1]
FILES = ("MEMORY.md", "default_prompt.md", "CLAUDE.md")
FORBIDDEN = ["Final Cut", "Premiere", "fcpxml", "prproj", "review file", "REVIEW_OUTPUT_SOFTWARE",
             "MAIN_AROLL_ROTATION", "whisper_gate", "flock", "vm_stat", "cpu.lock", "gpu.lock", ".venv",
             "CLAUDE_VE_ALL_OWN", chr(0x2014)]


class InstructionFiles(unittest.TestCase):
    def test_no_forbidden_words(self):
        for name in FILES:
            text = (TOOLKIT / name).read_text(encoding="utf-8").lower()
            for word in FORBIDDEN:
                self.assertNotIn(word.lower(), text, f"{name} mentions {word!r}")

    def test_header_names_are_used(self):
        text = (TOOLKIT / "default_prompt.md").read_text(encoding="utf-8")
        for name in ("MAIN_FOLDER", "CHANNEL_FOLDER", "TOOLKIT_FOLDER", "BROLL_FOLDER", "VIDEO_TYPE",
                     "PROJECT_FOLDER", "CHECK_COMMAND", "[OUTPUT COMPLETED]"):
            self.assertIn(name, text)
        for name in ("PRODUCT_LINKS", "CHANNEL_STYLE"):
            self.assertNotIn(name, text)

    def test_claude_md_is_short(self):
        lines = (TOOLKIT / "CLAUDE.md").read_text(encoding="utf-8").splitlines()
        self.assertTrue(20 <= len(lines) <= 40, len(lines))

    def test_memory_note_and_one_sentence_per_line(self):
        text = (TOOLKIT / "MEMORY.md").read_text(encoding="utf-8")
        self.assertIn("shared by everybody's edits", text)
        self.assertIn("read-only", text)
        for n, line in enumerate(text.splitlines(), 1):
            self.assertIsNone(re.search(r"[.!?] [A-Z]", line), f"MEMORY.md line {n} has two sentences")

    def test_version(self):
        self.assertEqual((TOOLKIT / "VERSION").read_text().strip(), "1.3.1")


if __name__ == "__main__":
    unittest.main()
