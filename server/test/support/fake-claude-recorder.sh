#!/bin/sh
# A fake `claude` that only records that it was started: one line "start <arguments>" in the file
# FAKE_CLAUDE_LOG, then it exits at once without output. For the tests that a setup that does not
# use Claude Code never starts the program.
if [ -n "${FAKE_CLAUDE_LOG:-}" ]; then
  printf 'start %s\n' "$*" >>"$FAKE_CLAUDE_LOG"
fi
exit 0
