"""Timeline model shared by the planner, the FCPXML writer/reader and the renderer.

All times are integer frames at the timeline's frame rate (`fps`, default 24000/1001 =
23.976; project.json "fps" sets it, e.g. "25" for 25p camera A-roll, "60000/1001" for 59.94
phone A-roll); audio is 48 kHz, 2002 samples per frame at 23.976, 1920 at 25, and 800.8 at
59.94, where frame boundaries are rounded down to whole samples.  A timeline has:

  spine      ordered primary-storyline items, each an A-roll clip or a gap, laid end to
             end from record frame 0 (their record position is implied by order)
  connected  clips above (lane > 0, video) or below (lane < 0, audio) the spine, each
             with an explicit record start

Transforms use Final Cut Pro semantics: `scale` multiplies the frame (after the media
is fitted to the frame), `pos` is an (x, y) offset in percent of the frame height with
+y up.
"""
import json
from dataclasses import asdict, dataclass, field
from fractions import Fraction
from pathlib import Path

SR = 48000
DEFAULT_FPS = "24000/1001"
# frame duration as Final Cut Pro writes it (numerator/denominator of seconds per frame)
FCP_FRAME = {Fraction(24000, 1001): (1001, 24000), Fraction(24): (100, 2400), Fraction(25): (100, 2500),
             Fraction(30000, 1001): (1001, 30000), Fraction(30): (100, 3000), Fraction(50): (100, 5000),
             Fraction(60000, 1001): (1001, 60000), Fraction(60): (100, 6000)}


class Rate:
    """One frame rate: frame <-> second conversion, samples per frame, ffmpeg and FCP spellings."""

    def __init__(self, fps=DEFAULT_FPS):
        self.fps = Fraction(fps)
        spf = SR / self.fps
        # samples per frame: whole at 23.976 / 25 (2002 / 1920), fractional at 59.94 (800.8)
        self.spf = int(spf) if spf.denominator == 1 else spf
        num, den = FCP_FRAME.get(self.fps, (self.fps.denominator, self.fps.numerator))
        self.fcp_num, self.fcp_den = num, den

    def __eq__(self, other):
        return isinstance(other, Rate) and self.fps == other.fps

    @property
    def ff(self):
        """ffmpeg spelling ("24000/1001", "25")."""
        return str(self.fps)

    @property
    def ntsc(self):
        return self.fps == Fraction(24000, 1001)

    def f2s(self, frames):
        return float(frames / self.fps)

    def s2f(self, seconds):
        return int(round(Fraction(seconds).limit_denominator(1_000_000) * self.fps))

    def samples(self, frames):
        """48 kHz sample index where frame `frames` starts (rounded down when a frame is not a
        whole number of samples, so neighbouring clips never overlap or leave a gap)."""
        return int(frames * self.spf)

    def seek(self, frames):
        """ffmpeg -ss value half a frame before `frames`: the first decoded frame at or after it
        is that frame.  (23.976 keeps its historical spelling so cached shots stay valid.)"""
        if self.ntsc:
            return f"{(frames * 1001 - 500) / 24000:.6f}"
        return f"{float((Fraction(frames) - Fraction(1, 2)) / self.fps):.6f}"

    def gfx_frames(self, seconds):
        """Frames of a HyperFrames graphic `seconds` long.  23.976 graphics are rendered at 24 fps
        and re-timed 1:1 (same frame count); other rates are rendered natively."""
        return int(round(seconds * 24)) if self.ntsc else int(round(seconds * self.fps))

    def fcp_time(self, frames):
        return "0s" if frames == 0 else f"{frames * self.fcp_num}/{self.fcp_den}s"

    @property
    def fcp_frame(self):
        return f"{self.fcp_num}/{self.fcp_den}s"


@dataclass
class Clip:
    asset: str                    # key into Timeline.assets ("" for a gap)
    dur: int                      # frames
    src: int = 0                  # in-point in the asset, frames
    rec: int = 0                  # record start (connected clips; filled in for spine)
    lane: int = 0                 # 0 = spine
    scale: float = 1.0
    pos: tuple = (0.0, 0.0)
    volume_db: float = 0.0
    fade_in: int = 0              # audio fade-in, frames
    fade_out: int = 0             # audio fade-out, frames
    video: bool = True            # contributes picture
    audio: bool = True            # contributes sound
    name: str = ""

    @property
    def end(self):
        return self.rec + self.dur


@dataclass
class Timeline:
    width: int = 2160
    height: int = 3840
    fps: str = DEFAULT_FPS
    assets: dict = field(default_factory=dict)
    spine: list = field(default_factory=list)
    connected: list = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    # the video folder the stored asset paths are relative to; set by whoever loads or plans
    # the timeline, never saved in it
    base: object = field(default=None, repr=False, compare=False)

    def path(self, stored):
        """Real path of a stored asset path string (see paths.py)."""
        from .paths import resolve
        if self.base is None:
            raise ValueError("this timeline has no video folder (base) to resolve asset paths against")
        return resolve(stored, self.base)

    def layout(self):
        """Fill in record starts of spine items from their order."""
        t = 0
        for c in self.spine:
            c.rec = t
            t += c.dur
        return t

    @property
    def rate(self):
        return Rate(self.fps)

    def f2s(self, frames):
        return self.rate.f2s(frames)

    @property
    def duration(self):
        return sum(c.dur for c in self.spine)

    def save(self, path):
        self.layout()
        d = asdict(self)
        d.pop("base", None)
        Path(path).write_text(json.dumps(d, indent=1, ensure_ascii=False), encoding="utf-8")

    @classmethod
    def load(cls, path, base=None):
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        tl = cls(width=d["width"], height=d["height"], fps=d.get("fps", DEFAULT_FPS), assets=d["assets"],
                 meta=d.get("meta", {}), base=base)
        tl.spine = [Clip(**{**c, "pos": tuple(c["pos"])}) for c in d["spine"]]
        tl.connected = [Clip(**{**c, "pos": tuple(c["pos"])}) for c in d["connected"]]
        tl.layout()
        return tl
