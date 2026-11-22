"""server/test/support/fixtures/project-rules.json is run by server/test/timeline/profileRules.test.js too,
so the toolkit's check and the server's profile break the same rules on the same compositions."""
import json
import tempfile
from pathlib import Path

import common  # noqa: F401  (puts the toolkit on sys.path)
from vekit import hfproject

FIXTURE = Path(__file__).resolve().parents[2] / "server" / "test" / "support" / "fixtures" / "project-rules.json"

HOSTS = {
    "graphic": ('<div id="g-1" class="clip" data-composition-id="g-1" data-composition-src="compositions/g-1.html" '
                'data-start="1" data-duration="2" data-track-index="1" data-vidai-kind="graphic" '
                'data-vidai-label="G" style="z-index:1"></div>'),
    "overlay": ('<div id="g-1" class="clip" data-composition-id="g-1" data-composition-src="compositions/g-1.html" '
                'data-start="1" data-duration="2" data-track-index="2" data-vidai-kind="overlay" '
                'data-vidai-label="G" style="z-index:2"></div>'),
}
AROLL = ('<video id="a-1" class="clip" src="assets/media/v.mp4" data-start="0" data-duration="4" data-media-start="0" '
         'data-track-index="0" data-vidai-kind="aroll" data-vidai-label="L" style="z-index:0"></video>')


class ProjectRulesTest(common.Case):
    def project(self, host_kind, composition):
        out = Path(tempfile.mkdtemp(dir=self.tmp))
        (out / "shared" / "js").mkdir(parents=True)
        (out / "shared" / "js" / "gsap.min.js").write_text("//")
        (out / "assets" / "media").mkdir(parents=True)
        (out / "assets" / "media" / "v.mp4").write_text("x")
        (out / "compositions").mkdir()
        (out / "compositions" / "g-1.html").write_text(composition, encoding="utf-8")
        (out / "index.html").write_text(
            '<html><head><script src="shared/js/gsap.min.js"></script></head><body>'
            '<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" '
            f'data-fps="30" data-duration="4">{AROLL}{HOSTS[host_kind]}</div><script>{hfproject.ROOT_SCRIPT}</script></body></html>',
            encoding="utf-8")
        (out / "edit.json").write_text(json.dumps({
            "toolkitVersion": "1", "fps": "30", "width": 1920, "height": 1080,
            "sources": [{"name": "v.mp4", "path": "assets/media/v.mp4", "originalPath": "/x/v.mp4",
                         "frames": 300, "fps": "30"}], "graphics": []}), encoding="utf-8")
        return out

    def test_every_case_breaks_the_rules_the_server_expects(self):
        if not FIXTURE.exists():
            self.skipTest("the server's fixtures are not next to the toolkit")
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 20)
        for case in cases:
            problems = hfproject.check_project(self.project(case["hostKind"], case["composition"]))
            rules = sorted({int(p.split(":")[0].split()[1]) for p in problems if p.startswith("Rule ")})
            self.assertEqual(rules, case["rules"], (case["name"], problems))
