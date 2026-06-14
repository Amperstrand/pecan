# syntax=docker/dockerfile:1
#
# Single image containing two binaries:
#   * cdk-mintd            — STOCK upstream cdk, installed from a pinned commit.
#   * cdk-branch-processor — this repo's custom payment processor + operator UI.
#
# Both are pinned to the same cdk commit (CDK_REV). They must match: the merge
# that added quote_id propagation also bumped the payment-processor wire
# protocol to 3.0.0, and the version check between mint and processor is
# strict-equality. processor/Cargo.toml pins the same rev as a git dependency.

ARG CDK_REV=bc7e441ef2fc4cb0d57b84c4757ee023704c922f

FROM node:22-bookworm-slim AS web-builder
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
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

# --- stock cdk-mintd, pinned, lean feature set (no cln/lnd/lnbits/fakewallet) ---
# grpc-processor: talk to our processor over gRPC
# management-rpc: keyset rotation from the operator UI
# sqlite:         persistent mint DB
# info-page:      human-readable mint info at the root URL
RUN cargo install \
        --git https://github.com/cashubtc/cdk \
        --rev ${CDK_REV} \
        --locked \
        --no-default-features \
        --features "management-rpc,grpc-processor,sqlite,info-page" \
        --root /out \
        cdk-mintd

# --- this repo's processor (git-deps the same cdk rev) ---
WORKDIR /src/processor
COPY processor/Cargo.toml processor/Cargo.lock* ./
COPY processor/src ./src
COPY processor/assets ./assets
RUN cargo build --release && cp target/release/cdk-branch-processor /out/bin/

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl3 \
        libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /out/bin/cdk-mintd /usr/local/bin/cdk-mintd
COPY --from=builder /out/bin/cdk-branch-processor /usr/local/bin/cdk-branch-processor
COPY --from=web-builder /src/web/dist /usr/local/share/custom-unit-mint/web

# default command is overridden per-service in docker-compose.yml
CMD ["cdk-mintd"]
