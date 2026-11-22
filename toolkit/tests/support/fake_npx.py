#!/usr/bin/env python3
"""Stands in for `npx -y hyperframes@x render|snapshot ...` in the tests (no network, no Chrome).

`render`: reads data-width, data-height and data-duration from ./index.html and writes a fully
transparent ProRes 4444 clip of that size to the -o path.  `snapshot`: writes one PNG into the
-o folder.  It also records its own command line and the state of the work folder in
$FAKE_NPX_LOG (one JSON line per call), so a test can check what the toolkit asked for.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

args = sys.argv[1:]
log = os.environ.get("FAKE_NPX_LOG")
cwd = Path.cwd()
html = (cwd / "index.html").read_text(encoding="utf-8")
num = lambda name, default: float(re.search(rf'data-{name}="([\d.]+)"', html).group(1)) if re.search(rf'data-{name}="', html) else default  # noqa: E731
if log:
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"args": args, "shared": (cwd / "shared" / "fonts").exists() or (cwd / "shared").exists(),
                            "slots": sorted(x.name for x in Path(os.environ["VE_GPU_SLOTS_DIR"]).glob("slot-*"))
                        if os.environ.get("VE_GPU_SLOTS_DIR") else None}) + "\n")
ffmpeg = os.environ.get("VE_FFMPEG", "ffmpeg")
sub = args[2]                                       # -y hyperframes@x <sub>
out = Path(args[args.index("-o") + 1])
w, h, dur = int(num("width", 1920)), int(num("height", 1080)), num("duration", 1)
if sub == "render":
    fps = args[args.index("--fps") + 1]
    cmd = [ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", f"color=black@0.0:s={w}x{h}:r={fps}:d={dur},format=yuva444p10le",
           "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", str(out)]
else:
    out.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", f"color=0x336699:s={w}x{h}", "-frames:v", "1", str(out / "frame.png")]
sys.exit(subprocess.run(cmd).returncode)
