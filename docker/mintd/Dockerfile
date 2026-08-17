# syntax=docker/dockerfile:1
#
# TEMPORARY: a stock cdk-mintd built from the cdk revision this processor
# requires — the head of PR cashubtc/cdk#2295 (quote_id + NUT-20 pubkey on
# custom mint quotes, payment-processor protocol 4.0.0). The protocol check
# between mint and processor is strict-equality, so until an upstream release
# contains the PR, a compatible mintd must be built from this exact rev.
#
# No patches are applied — this is unmodified cdk. Delete this file once the
# PR ships in a cdk release and point operators at the official artifacts.
# Keep CDK_REV in lockstep with processor/Cargo.toml and COMPATIBLE_CDK_REV
# in processor/src/config.rs.
#
# Build:  docker build -t cdk-mintd-branch -f docker/mintd/Dockerfile .
# Run:    mount your mint.toml (see docs/examples/mint.toml) and a data dir:
#         docker run -v ./mint.toml:/root/.cdk-mintd/config.toml \
#                    -v mintd-data:/root/.cdk-mintd -p 8089:8089 cdk-mintd-branch

ARG CDK_REPO=https://github.com/zeugmaster/cdk
ARG CDK_REV=f3478044380d057d337174d7c6631ffc3159bf2c

FROM rust:slim-bookworm AS builder
ARG CDK_REPO
ARG CDK_REV

RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        libsqlite3-dev \
        protobuf-compiler \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git init -q /src/cdk \
    && git -C /src/cdk remote add origin ${CDK_REPO} \
    && git -C /src/cdk fetch --depth 1 origin ${CDK_REV} \
    && git -C /src/cdk checkout -q FETCH_HEAD
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build-target,id=cdk-mintd-target \
    cd /src/cdk \
    && CARGO_TARGET_DIR=/build-target cargo install \
        --path crates/cdk-mintd \
        --locked \
        --no-default-features \
        --features "management-rpc,grpc-processor,sqlite,info-page" \
        --root /out \
        cdk-mintd

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libssl3 \
        libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /out/bin/cdk-mintd /usr/local/bin/cdk-mintd

# 8089 mint HTTP API · 8091 management RPC (if enabled in mint.toml)
EXPOSE 8089 8091
CMD ["cdk-mintd"]
