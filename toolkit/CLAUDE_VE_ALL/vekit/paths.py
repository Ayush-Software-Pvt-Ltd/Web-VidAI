"""Where things live.  The only module that knows the folder layout.

  <toolkit>/CLAUDE_VE_ALL/   this code, the design kits, templates and sound effects.  Found from
                             this file's own location and only READ: nothing is ever written there.
  <video>/                   one video folder, given to every command as an absolute path (a
                             relative one is resolved against the current directory).  It lies
                             anywhere; the toolkit does not care where.
  <video>/CLAUDE_VE/         that video's working files (project.json, timeline.py, transcripts,
                             audio, graphics, builds, previews).  Everything there can be rebuilt.
  <channel>/                 the video folder's parent, or VE_CHANNEL_DIR when that is set.

Paths stored inside a timeline (assets) are strings with forward slashes:
  "Main.mp4"                relative to the video folder (so the folder can be moved)
  "@kit/sfx/whoosh1.wav"    relative to CLAUDE_VE_ALL (a file of the toolkit)
  "C:/media/other.mp4"      absolute, for a file that lies elsewhere
"""
import os
from pathlib import Path, PurePosixPath, PureWindowsPath

KIT = Path(__file__).resolve().parents[1]          # CLAUDE_VE_ALL
SHARED = KIT / "gfx" / "_shared"
TEMPLATES = KIT / "gfx" / "templates"
SFX = KIT / "sfx"
DTD = KIT / "vekit" / "FCPXMLv1_14.dtd"
KIT_PREFIX = "@kit/"


def video_dir(main):
    """Absolute video folder for a command argument (relative: against the current directory).
    `..` is folded away; links are not followed, so the path stays what the caller wrote."""
    p = Path(os.path.expanduser(str(main)))
    return Path(os.path.abspath(p))


def project_dir(main):
    """Working folder of one video: <video>/CLAUDE_VE."""
    return video_dir(main) / "CLAUDE_VE"


def channel_dir(main):
    """The channel directory: VE_CHANNEL_DIR, else the video folder's parent."""
    env = os.environ.get("VE_CHANNEL_DIR")
    if env:
        return Path(os.path.abspath(os.path.expanduser(env)))
    return video_dir(main).parent


def is_absolute(stored):
    """True for an absolute path of either operating system (a stored path may come from the other)."""
    s = str(stored)
    return PurePosixPath(s).is_absolute() or PureWindowsPath(s).is_absolute()


def rel(path, base):
    """The string to store in a timeline for `path`, as described in the module doc."""
    p = Path(os.path.abspath(path))
    for root, prefix in ((Path(os.path.abspath(base)), ""), (KIT, KIT_PREFIX)):
        for a, b in ((p, root), (p.resolve(), root.resolve())):
            try:
                return prefix + a.relative_to(b).as_posix()
            except ValueError:
                continue
    return p.as_posix()


def resolve(stored, base):
    """The real path of a stored string (the reverse of `rel`)."""
    s = str(stored)
    if s.startswith(KIT_PREFIX):
        return KIT / s[len(KIT_PREFIX):]
    if is_absolute(s):
        return Path(s)
    return Path(base) / s
