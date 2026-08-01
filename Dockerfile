# syntax=docker/dockerfile:1
#
# Single image containing two binaries:
#   * cdk-mintd            — pinned upstream cdk with a narrow managed-unit patch.
#   * cdk-branch-processor — this repo's custom payment processor + operator UI.
#
# Both are pinned to the same cdk commit (CDK_REV). They must match because the
# payment-processor wire protocol check between mint and processor is
# strict-equality. processor/Cargo.toml pins the same rev as a git dependency.
#
# Cache mounts are per-builder scratch space: they speed up local iteration and
# same-runner CI rebuilds but are never exported with the image. Anything that
# must survive across CI runs via the registry layer cache is arranged as its
# own layer instead — the cdk-mintd stage (invalidated only by CDK_REV, the
# patch, or the base image) and the processor dependency layer (invalidated
# only by Cargo.toml/Cargo.lock).

ARG CDK_REV=6132607495ae0741e412a63f2acc34e4ccddfc55

FROM node:22-bookworm-slim AS web-builder
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web ./
RUN npm run build

FROM rust:slim-bookworm AS builder
ARG CDK_REV

RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        libsqlite3-dev \
        protobuf-compiler \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

# --- cdk-mintd, pinned, lean feature set (no cln/lnd/lnbits/fakewallet) ---
# grpc-processor: talk to our processor over gRPC
# management-rpc: keyset rotation from the operator UI
# sqlite:         persistent mint DB
# info-page:      human-readable mint info at the root URL
WORKDIR /src
RUN git init -q /src/cdk \
    && git -C /src/cdk remote add origin https://github.com/cashubtc/cdk \
    && git -C /src/cdk fetch --depth 1 origin ${CDK_REV} \
    && git -C /src/cdk checkout -q FETCH_HEAD
COPY patches/cdk-managed-units.patch /src/cdk-managed-units.patch
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build-target,id=cdk-mintd-target \
    cd /src/cdk \
    && git apply /src/cdk-managed-units.patch \
    && CARGO_TARGET_DIR=/build-target cargo install \
        --path crates/cdk-mintd \
        --locked \
        --no-default-features \
        --features "management-rpc,grpc-processor,sqlite,info-page" \
        --root /out \
        cdk-mintd

# --- this repo's processor (git-deps the same cdk rev) ---
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
    && cp target/release/cdk-branch-processor /out/bin/

FROM debian:bookworm-slim
# Stamped by CI with the git tag (or edge-<sha>); "dev" for local builds.
ARG VERSION=dev

# curl exists solely for the compose-level healthchecks; there is no
# image-level HEALTHCHECK because the two services sharing this image have
# different health semantics (processor /healthz vs. supervisor state).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libssl3 \
        libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /out/bin/cdk-mintd /usr/local/bin/cdk-mintd
COPY --from=builder /out/bin/cdk-branch-processor /usr/local/bin/cdk-branch-processor
COPY --from=web-builder /src/web/dist /usr/local/share/custom-unit-mint/web
COPY scripts/mint-supervisor.sh /usr/local/bin/mint-supervisor
COPY scripts/mint-health.sh /usr/local/bin/mint-health
RUN chmod 0755 /usr/local/bin/mint-supervisor /usr/local/bin/mint-health

ENV CDK_BRANCH_PROCESSOR_VERSION=${VERSION}
# Links the GHCR package to this repository so pulls resolve the source.
LABEL org.opencontainers.image.source=https://github.com/zeugmaster/custom-unit-mint
# Documentation only; docker-compose.yml controls what is actually published.
# 9090 operator UI · 50051 payment gRPC · 8089 mint API · 8091 mint mgmt RPC
EXPOSE 9090 50051 8089 8091

# default command is overridden per-service in docker-compose.yml
CMD ["cdk-mintd"]
