# syntax=docker/dockerfile:1
#
# The branch processor image: one binary (cdk-branch-processor) plus the built
# operator UI. The mint is NOT part of this image — the processor attaches to
# a cdk-mintd the operator runs themselves. While PR cashubtc/cdk#2295 is
# unreleased, docker/mintd/Dockerfile builds a compatible mintd from the same
# pinned cdk revision (processor/Cargo.toml is the source of truth for it).
#
# Cache mounts are per-builder scratch space: they speed up local iteration
# and same-runner CI rebuilds but are never exported with the image. The
# processor dependency layer (invalidated only by Cargo.toml/Cargo.lock) is a
# real layer so the CI registry cache can reuse it.

FROM node:22-bookworm-slim AS web-builder
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
COPY web/vendor ./vendor
# The lockfile is generated on macOS; its optional-dep records miss the linux
# rolldown native binding (npm/cli#4828), so drop it and resolve fresh.
RUN --mount=type=cache,target=/root/.npm rm -f package-lock.json && npm install
COPY web ./
RUN npm run build

FROM rust:slim-bookworm AS builder

# git: cargo fetches the pinned cdk git dependencies.
# protobuf-compiler: cdk-payment-processor generates its gRPC stubs at build time.
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        protobuf-compiler \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

# Dependencies compile in their own layer against a dummy main so a
# source-only change (the common case) reuses it, including from the CI
# registry cache — which stores layers, not cache mounts, hence no target
# cache mount here.
WORKDIR /src/processor
COPY processor/Cargo.toml processor/Cargo.lock ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src
COPY processor/src ./src
COPY processor/assets ./assets
# touch: COPY preserves source mtimes, which can predate the dummy-main build
# and fool cargo's freshness check into skipping the real main.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    touch src/main.rs \
    && cargo build --release --locked \
    && mkdir -p /out/bin \
    && cp target/release/cdk-branch-processor /out/bin/

FROM debian:bookworm-slim
# Stamped by CI with the git tag (or edge-<sha>); "dev" for local builds.
ARG VERSION=dev

# curl exists solely for the compose-level healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /out/bin/cdk-branch-processor /usr/local/bin/cdk-branch-processor
COPY --from=web-builder /src/web/dist /usr/local/share/pecan/web

ENV CDK_BRANCH_PROCESSOR_VERSION=${VERSION}
# Links the GHCR package to this repository so pulls resolve the source.
LABEL org.opencontainers.image.source=https://github.com/zeugmaster/pecan
# Documentation only; docker-compose.yml controls what is actually published.
# 9090 operator UI · 50051 payment gRPC (the mint connects in)
EXPOSE 9090 50051

CMD ["cdk-branch-processor"]
