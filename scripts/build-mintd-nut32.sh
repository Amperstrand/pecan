#!/bin/sh
# Build the NUT-32 forked cdk-mintd image on ai-legion-small (32GB — inr2
# OOMs on Rust builds) and load it on inr2 as cashubtc/mintd:nut32.
#
# Source: $CDK_NUT32_DIR (default ~/src/cdk-nut32, branch pecan-nut32 —
# a fork of cashubtc/cdk v0.18.0 with the NUT-32 spike; see
# docs/egg-futures-spike.md). The official cashubtc/mintd:0.18.0 image
# keeps serving the EUR/USD/NOK pairs — only the farm pair runs this.
#
# Usage: scripts/build-mintd-nut32.sh [--load]   (default: build + ship)
set -eu

BUILDER=ai-legion-small
SERVER=root@46.224.104.12
REMOTE_DIR=/tmp/cdk-nut32-build
IMAGE=cashubtc/mintd:nut32

CDK_NUT32_DIR="${CDK_NUT32_DIR:-$HOME/src/cdk-nut32}"
if [ ! -d "$CDK_NUT32_DIR/crates/cdk-mintd" ]; then
  echo "no cdk fork at $CDK_NUT32_DIR (expected branch pecan-nut32)" >&2
  exit 1
fi

echo "==> rsync fork to $BUILDER:$REMOTE_DIR"
ssh "$BUILDER" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR"
rsync -a --delete \
  --exclude target --exclude .git \
  "$CDK_NUT32_DIR"/ "$BUILDER:$REMOTE_DIR"/

echo "==> docker build on $BUILDER"
# The official image builds cdk-mintd with the full feature set (see the
# upstream Dockerfile's nix build line); here we mirror the feature set
# the deployment uses: grpc processor, sqlite, info page, prometheus,
# management rpc. A plain cargo build inside the rust image keeps the
# lane independent of nix.
ssh "$BUILDER" "cd $REMOTE_DIR && DOCKER_BUILDKIT=1 docker build -t $IMAGE -f- . <<'DOCKERFILE'
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler clang libsqlite3-dev && rm -rf /var/lib/apt/lists/*
RUN cargo build --release -p cdk-mintd --features grpc-processor,sqlite,info-page,prometheus,management-rpc

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates sqlite3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/cdk-mintd /usr/local/bin/cdk-mintd
ENTRYPOINT [\"cdk-mintd\"]
DOCKERFILE"

if [ "${1:-}" = "--load" ] || [ "${1:-}" = "" ]; then
  echo "==> ship image to inr2"
  ssh "$BUILDER" "docker save $IMAGE | gzip > $REMOTE_DIR/mintd-nut32.tar.gz"
  scp -q "$BUILDER:$REMOTE_DIR/mintd-nut32.tar.gz" /tmp/mintd-nut32.tar.gz
  # inr2 disk is tight (~5G free): clean the transfer artifacts immediately.
  ssh "$BUILDER" "rm -f $REMOTE_DIR/mintd-nut32.tar.gz"
  scp -q /tmp/mintd-nut32.tar.gz "$SERVER:/tmp/"
  ssh "$SERVER" "gunzip -f /tmp/mintd-nut32.tar.gz && docker load -i /tmp/mintd-nut32.tar && rm -f /tmp/mintd-nut32.tar* && docker builder prune -af >/dev/null 2>&1 || true"
  rm -f /tmp/mintd-nut32.tar.gz
  echo "==> loaded $IMAGE on inr2"
fi
