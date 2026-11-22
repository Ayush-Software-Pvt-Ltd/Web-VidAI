"""The VidAI editing toolkit (see ../../README.md)."""
import sys

# The toolkit folder is only read (SPEC section 9): no __pycache__ is written into it.
sys.dont_write_bytecode = True


def _utf8_stdio():
    # Windows consoles default to a legacy code page; transcripts are Hindi, so never crash on print.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


_utf8_stdio()
