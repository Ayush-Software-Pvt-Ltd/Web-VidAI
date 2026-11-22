"""Where the external programs are: ffmpeg and ffprobe on PATH, overridable, and npx.

VE_FFMPEG, VE_FFPROBE, VE_NPX and VE_NODE name the programs (a full path or a name on PATH);
VE_HYPERFRAMES is the path of a hyperframes.mjs that is used instead of npx.  Read at every
call, so a test or the server can change them.  On Windows `npx` is `npx.cmd`, which a
subprocess argument list cannot start by its bare name, hence the lookup.
"""
import os
import shutil
from pathlib import Path

from .paths import SHARED


def _find(env_name, default):
    wanted = os.environ.get(env_name) or default
    return shutil.which(wanted) or wanted


def ffmpeg():
    return _find("VE_FFMPEG", "ffmpeg")


def ffprobe():
    return _find("VE_FFPROBE", "ffprobe")


def npx():
    return _find("VE_NPX", "npx")


def node():
    return _find("VE_NODE", "node")


HYPERFRAMES_PACKAGE = "hyperframes@0.9.80"


def hyperframes(package=None):
    """The command (a list) that starts the HyperFrames CLI, to which the sub-command is appended.

    VE_HYPERFRAMES, the path of a `hyperframes.mjs` (the server's pinned copy), is started with
    VE_NODE or `node`; without it `npx -y hyperframes@<pin>` fetches the package."""
    mjs = os.environ.get("VE_HYPERFRAMES")
    if mjs:
        return [node(), mjs]
    return [npx(), "-y", package or HYPERFRAMES_PACKAGE]


def label_font(size):
    """A bold font for labels on contact sheets and QA frames.

    VE_FONT (a font file) first, then a font that ships in the toolkit (so every operating system
    draws the same labels), then Pillow's own default.
    """
    from PIL import ImageFont
    for p in (os.environ.get("VE_FONT"), SHARED / "xxx" / "fonts" / "Barlow-Bold.ttf"):
        if p and Path(p).exists():
            try:
                return ImageFont.truetype(str(p), size)
            except OSError:
                pass
    try:
        return ImageFont.load_default(size)
    except TypeError:                               # Pillow before 10.1
        return ImageFont.load_default()
