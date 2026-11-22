#!/bin/bash
# Starts VidAI Server: the app in your browser, the backend on this computer.
#
#   ./start.sh                      install and build what is missing, then start
#   ./start.sh --port 15000         use another port
#   ./start.sh -h                   show every option
#
# Stop it with Ctrl+C in this window (running edits are paused first).
set -euo pipefail

cd "$(dirname "$0")"

fail() {
  echo "start.sh: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install version 22.13 or newer from https://nodejs.org and run this again."
command -v npm >/dev/null 2>&1 || fail "npm is not installed. It comes with Node.js from https://nodejs.org."

# node:sqlite needs 22.13 (it runs without a flag from there on).
node_version="$(node -p 'process.versions.node')"
node_major="${node_version%%.*}"
node_rest="${node_version#*.}"
node_minor="${node_rest%%.*}"
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 13 ]; }; then
  fail "Node.js $node_version is too old. VidAI needs version 22.13 or newer (https://nodejs.org)."
fi

# Install the dependencies on the first start and whenever package-lock.json changed since.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing dependencies (first start, or they changed)..."
  npm install
fi

# Build the UI on the first start and whenever its sources are newer than the build.
needs_build=0
if [ ! -f dist/index.html ]; then
  needs_build=1
elif [ -n "$(find src index.html package.json vite.config.ts -newer dist/index.html -type f -print -quit 2>/dev/null)" ]; then
  needs_build=1
fi
if [ "$needs_build" -eq 1 ]; then
  echo "Building the user interface..."
  npm run build
fi

# Replace this shell with the server, so Ctrl+C reaches it directly.
exec node server/src/main.js "$@"
