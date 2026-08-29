#!/bin/sh
# Regenerate web/package-lock.json on linux. Run whenever web/package.json
# or web/vendor changes: macOS npm drops the linux rolldown bindings from the
# lockfile (npm/cli#4828), which breaks `npm ci` in the Docker build.
# Requires a local docker daemon; the server's works too — this runs the
# exact builder image so the lockfile matches production.
# Usage: scripts/gen-web-lockfile.sh
set -eu
cd "$(dirname "$0")/../web"
docker run --rm -v "$PWD":/app -w /app node:22-bookworm-slim \
  sh -c 'rm -rf node_modules package-lock.json && npm install --no-audit --no-fund' \
  >/dev/null
grep -q "node_modules/@rolldown/binding-linux" package-lock.json \
  || { echo "lockfile lacks linux bindings; generation failed" >&2; exit 1; }
echo "linux lockfile written: $(wc -l < package-lock.json | tr -d ' ') lines"
