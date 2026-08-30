#!/bin/sh
# Verify embedded NUT spec quotes still match the cashubtc/nuts checkout.
# Prereqs (once):
#   uv tool install git+https://github.com/rustyrussell/greatspectations.git
#   git clone --depth 1 https://github.com/cashubtc/nuts ../nuts
# Usage: scripts/spec-quote-check.sh
set -eu
cd "$(dirname "$0")/.."
exec greatspectate check --config specquotes.toml \
  --comment-start '// ' --comment-continue '//' \
  web/src/lib/coco/mint-branch-handler.ts \
  web/src/lib/coco/melt-branch-handler.ts \
  processor/src/backend.rs
