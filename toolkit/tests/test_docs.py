"""The agents' standing instructions must not mention what the toolkit no longer does."""
import re
import unittest
from pathlib import Path

TOOLKIT = Path(__file__).resolve().parents[1]
FILES = ("MEMORY.md", "default_prompt.md", "CLAUDE.md")
FORBIDDEN = ["Final Cut", "Premiere", "fcpxml", "prproj", "review file", "REVIEW_OUTPUT_SOFTWARE",
             "MAIN_AROLL_ROTATION", "whisper_gate", "flock", "vm_stat", "cpu.lock", "gpu.lock", ".venv",
             "CLAUDE_VE_ALL_OWN", chr(0x2014), "ProRes", "render_one", "volume lane", "reuse the build script",
             "priority is to finish", "zsh", "pip is not supported"]


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

    def test_claude_md_names_commands_that_exist(self):
        text = (TOOLKIT / "CLAUDE.md").read_text(encoding="utf-8")
        kit = TOOLKIT / "CLAUDE_VE_ALL"
        ve = (kit / "ve.py").read_text(encoding="utf-8")
        for script in sorted(set(re.findall(r"`(\w+\.py)", text)) - {"timeline.py"}):   # timeline.py is the video's own file
            self.assertTrue((kit / script).is_file(), f"CLAUDE.md names {script}, which does not exist")
        for command in sorted(set(re.findall(r"`ve\.py (\w+)", text))):
            self.assertIn(f'sub.add_parser("{command}")', ve, f"CLAUDE.md names ve.py {command}")
        for needle in ("ve.py lang", "--lang auto", "sheet.py", "thumbs.py grab", "&"):
            self.assertIn(needle, text)

    def test_memory_note_and_one_sentence_per_line(self):
        text = (TOOLKIT / "MEMORY.md").read_text(encoding="utf-8")
        self.assertIn("shared by everybody's edits", text)
        self.assertIn("read-only", text)
        for n, line in enumerate(text.splitlines(), 1):
            self.assertIsNone(re.search(r"[.!?] [A-Z]", line), f"MEMORY.md line {n} has two sentences")

    def test_memory_length(self):
        n = len((TOOLKIT / "MEMORY.md").read_text(encoding="utf-8").splitlines())
        self.assertTrue(100 <= n <= 150, n)

    def test_claude_md_points_at_the_edit_contract(self):
        text = (TOOLKIT / "CLAUDE.md").read_text(encoding="utf-8")
        for needle in ("Writing the edit", "ve.py graphic", "ve.py frames --project"):
            self.assertIn(needle, text)
        self.assertIn("README.md", text.split("## Never")[1])

    def test_default_prompt_asks_for_density(self):
        text = (TOOLKIT / "default_prompt.md").read_text(encoding="utf-8")
        for needle in ("20 to 30 seconds", "ve.py graphic", "ve.py frames", "pip", "Parallel work is welcome"):
            self.assertIn(needle, text)


class Readme(unittest.TestCase):
    """The README is the manual of the edit contract the agent may read (vekit/ it may not)."""

    def text(self):
        return (TOOLKIT / "README.md").read_text(encoding="utf-8")

    def test_documents_every_command(self):
        ve = (TOOLKIT / "CLAUDE_VE_ALL" / "ve.py").read_text(encoding="utf-8")
        text = self.text()
        commands = re.findall(r'sub\.add_parser\("(\w+)"\)', ve)
        self.assertGreaterEqual(len(commands), 15)
        for command in commands:
            self.assertIn(f"`ve.py {command}`", text, f"README does not document ve.py {command}")

    def test_documents_the_timeline_contract(self):
        text = self.text()
        self.assertIn("## Writing the edit", text)
        for key in ("SEGS", "VIS", "BROLL", "OVL", "HITS", "SFX", "END_HOLD", "sync", "pip", "bg", "radius", "box",
                    "H", "HW", "HT", "G:", "B:", "plan.txt", "frames --project", "opaque"):
            self.assertIn(key, text, f"README does not mention {key}")

    def test_documents_every_graphic_template(self):
        text = self.text()
        for d in sorted((TOOLKIT / "CLAUDE_VE_ALL" / "gfx" / "templates").glob("graphic_*")):
            self.assertIn(f"| `{d.name[len('graphic_'):]}` |", text, f"README does not describe the template {d.name}")

    def test_no_em_dash_and_one_sentence_per_line(self):
        fenced = False
        for n, line in enumerate(self.text().splitlines(), 1):
            self.assertNotIn(chr(0x2014), line)
            if line.startswith("```"):
                fenced = not fenced
            if fenced or line.startswith("|"):
                continue
            self.assertIsNone(re.search(r"[.!?] [A-Z][a-z]", re.sub(r"`[^`]*`", "", line)), f"README line {n} has two sentences")


class Version(unittest.TestCase):
    def test_version(self):
        self.assertEqual((TOOLKIT / "VERSION").read_text().strip(), "1.4.0")


if __name__ == "__main__":
    unittest.main()
