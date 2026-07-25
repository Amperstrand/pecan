# syntax=docker/dockerfile:1
#
# Single image containing two binaries:
#   * cdk-mintd            — pinned upstream cdk with a narrow managed-unit patch.
#   * cdk-branch-processor — this repo's custom payment processor + operator UI.
#
# Both are pinned to the same cdk commit (CDK_REV). They must match because the
# payment-processor wire protocol check between mint and processor is
# strict-equality. processor/Cargo.toml pins the same rev as a git dependency.

ARG CDK_REV=6132607495ae0741e412a63f2acc34e4ccddfc55

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

# --- cdk-mintd, pinned, lean feature set (no cln/lnd/lnbits/fakewallet) ---
# grpc-processor: talk to our processor over gRPC
# management-rpc: keyset rotation from the operator UI
# sqlite:         persistent mint DB
# info-page:      human-readable mint info at the root URL
WORKDIR /src
RUN git clone https://github.com/cashubtc/cdk /src/cdk \
    && cd /src/cdk \
    && git checkout ${CDK_REV}
COPY patches/cdk-managed-units.patch /src/cdk-managed-units.patch
RUN cd /src/cdk \
    && git apply /src/cdk-managed-units.patch \
    && cargo install \
        --path crates/cdk-mintd \
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
COPY scripts/mint-supervisor.sh /usr/local/bin/mint-supervisor
RUN chmod 0755 /usr/local/bin/mint-supervisor

# default command is overridden per-service in docker-compose.yml
CMD ["cdk-mintd"]
