#!/bin/sh
# Rebuild the coco fork, pack tarballs, and vendor them into pecan/web.
# Usage: scripts/vendor-coco.sh [version]   (default: read from packages/core/package.json)
#
# Prereq: the fork at COCO_DIR is committed with the changes you want to ship.
set -eu

COCO_DIR="${COCO_DIR:-$HOME/src/coco}"
PECAN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACK_DIR=/tmp/coco-dist

cd "$COCO_DIR"
VERSION="${1:-$(python3 -c "import json; print(json.load(open('packages/core/package.json'))['version'])")}"

echo "==> typecheck + build + test coco @ $VERSION"
bun run --filter='@cashu/coco-core' typecheck
bun run build 2>&1 | tail -1
(cd packages/core && bun run test 2>&1 | grep -E "^\s+\d+ (pass|fail)" | head -2)

echo "==> pack $VERSION"
mkdir -p "$PACK_DIR"
(cd packages/core && npm pack --pack-destination "$PACK_DIR" >/dev/null)
(cd packages/indexeddb && npm pack --pack-destination "$PACK_DIR" >/dev/null)

echo "==> vendor into pecan/web"
rm -f "$PECAN_DIR/web/vendor"/cashu-coco-*.tgz
cp "$PACK_DIR"/cashu-coco-core-"$VERSION".tgz "$PACK_DIR"/cashu-coco-indexeddb-"$VERSION".tgz \
  "$PECAN_DIR/web/vendor/"
python3 - "$PECAN_DIR" "$VERSION" <<'EOF'
import json, re, sys
pecan, version = sys.argv[1], sys.argv[2]
pkg_path = f"{pecan}/web/package.json"
pkg = json.load(open(pkg_path))
for dep in ("@cashu/coco-core", "@cashu/coco-indexeddb"):
    pkg["dependencies"][dep] = re.sub(r"\d+\.\d+\.\d+", version, pkg["dependencies"][dep])
json.dump(pkg, open(pkg_path, "w"), indent=2)
print("package.json refs updated to", version)
EOF

cd "$PECAN_DIR/web"
rm -rf node_modules/@cashu/coco-core node_modules/@cashu/coco-indexeddb
npm install --no-audit --no-fund >/dev/null 2>&1
echo "==> vendored @cashu/coco-{core,indexeddb} $VERSION"
