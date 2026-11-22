#!/bin/bash
# Rebuilds src-tauri/resources/toolkit.tar.gz from an existing Editing Folder.
# The archive is what VidAI unpacks into a new Editing Folder that has no CLAUDE_VE_ALL yet.
# The source folder is only read: the snapshot is staged in a temporary directory.
# Usage: scripts/snapshot-toolkit.sh "/path/to/Editing Folder"
set -euo pipefail

SRC="${1:?Usage: scripts/snapshot-toolkit.sh \"/path/to/Editing Folder\"}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/resources/toolkit.tar.gz"

[ -d "$SRC/CLAUDE_VE_ALL" ] || { echo "error: $SRC/CLAUDE_VE_ALL not found" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Machine-specific or regenerated content is left out: the Python environment, Whisper lock
# slots, caches, HyperFrames editor state, scratch folders, and anything that holds secrets.
rsync -a \
  --exclude='.venv' --exclude='.whisper' --exclude='__pycache__' --exclude='.ruff_cache' \
  --exclude='.hyperframes' --exclude='node_modules' --exclude='.DS_Store' --exclude='.env' \
  --exclude='/CLAUDE_VE_ALL/tmp_*' --exclude='*.lock' \
  "$SRC/CLAUDE_VE_ALL" "$STAGE/"

ENTRIES=(CLAUDE_VE_ALL)
for f in MEMORY.md CLAUDE.md; do
  if [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$STAGE/$f"
    ENTRIES+=("$f")
  fi
done

# TypeSafe AI (Jev) is not part of VidAI: no Jev script, SDK dependency, key or lesson may ship.
# This fails loudly so a snapshot of an Editing Folder that still has Jev cannot bring it back.
JEV_HITS="$( { find "$STAGE" -iname '*jev*'; grep -rIilE -e 'typesafe' -e '\bjev\b' -e 'jev[-_]' -e '_jev' "$STAGE"; } 2>/dev/null | sort -u || true )"
if [ -n "$JEV_HITS" ]; then
  echo "error: the source toolkit still contains Jev (TypeSafe AI), which VidAI does not bundle:" >&2
  echo "$JEV_HITS" | sed "s|^$STAGE/|  |" >&2
  echo "Remove Jev from the source Editing Folder first (jev.py, vekit/jev.py, the typesafe-sdk line in" >&2
  echo "CLAUDE_VE_ALL/requirements.txt, and every Jev mention in MEMORY.md and CLAUDE.md), then snapshot again." >&2
  exit 1
fi

find "$STAGE" -name '__pycache__' -type d -prune -exec rm -rf {} +

if grep -rIl --exclude-dir='.git' -e 'dotenv' -e '\.env\b' "$STAGE/CLAUDE_VE_ALL" >/dev/null; then
  echo "error: the staged toolkit still refers to a .env file:" >&2
  grep -rIn -e 'dotenv' -e '\.env\b' "$STAGE/CLAUDE_VE_ALL" | cut -c1-200 >&2
  exit 1
fi

COPYFILE_DISABLE=1 tar -czf "$OUT" -C "$STAGE" "${ENTRIES[@]}"

echo "wrote $OUT ($(du -h "$OUT" | cut -f1), $(tar -tzf "$OUT" | wc -l | tr -d ' ') entries)"
