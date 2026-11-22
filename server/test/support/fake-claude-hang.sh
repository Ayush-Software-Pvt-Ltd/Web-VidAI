#!/bin/sh
# A fake Claude Code that hangs: it never reads stdin, never answers and ignores SIGTERM, so only
# SIGKILL ends it (and the `sleep` it runs). For the tests of `claude/control.js` that a helper is
# gone after `close()` even when it does not exit by itself.
trap '' TERM
while :; do sleep 1; done
