FROM docker.io/library/rust:1.97-trixie AS build

WORKDIR /src

COPY Cargo.toml Cargo.lock rustfmt.toml ./
COPY crates crates

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin timba-oracle --bin timba-evm-oracle && \
    install -D -m 0755 -t /out target/release/timba-oracle target/release/timba-evm-oracle

FROM docker.io/library/debian:trixie-slim

# RPC, Jupiter and EVM endpoints are reached over TLS with the system roots.
RUN apt-get update && \
    apt-get install --yes --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Relative defaults (oracle.sqlite, admin-keypair.json) resolve here.
WORKDIR /app

COPY --from=build /out/ /usr/local/bin/

# Expose default port (can be overridden by ORACLE_PORT)
EXPOSE 3001

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision="${VCS_REF}"

CMD ["timba-oracle", "serve"]
