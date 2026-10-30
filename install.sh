#!/bin/sh
# Native Linux, current account only. No automatic downloads.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo 'TEAA needs Node.js 22.19 or newer. Install it from https://nodejs.org and run this again.' >&2
  exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<19)){console.error("TEAA needs Node.js 22.19 or newer");process.exit(1)}'
exec node "$HERE/src/install.js" "$@"
