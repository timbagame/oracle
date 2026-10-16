FROM docker.io/library/rust:1.97-trixie@sha256:b1b3c9c0d921d7fa0a6d1f9ec7e4eab87f8c8ec97644c3d791450f131dec813f AS build

WORKDIR /src

COPY Cargo.toml Cargo.lock rustfmt.toml rust-toolchain.toml ./
COPY crates crates

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin timba-oracle --bin timba-evm-oracle && \
    install -D -m 0755 -t /out target/release/timba-oracle target/release/timba-evm-oracle

FROM docker.io/library/debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

# RPC, Jupiter and EVM endpoints are reached over TLS with the system roots.
RUN apt-get update && \
    apt-get install --yes --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Relative defaults (oracle.sqlite, admin-keypair.json) resolve here.
WORKDIR /app

COPY --from=build /out/ /usr/local/bin/
# Keeps hosts on the 0.2 Quadlets (bun health check and Exec) working; see the script.
COPY --chmod=0755 deploy/compat/bun /usr/local/bin/bun

# Expose default port (can be overridden by ORACLE_PORT)
EXPOSE 3001

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision="${VCS_REF}"

CMD ["timba-oracle", "serve"]
