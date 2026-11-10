# Keep this on the runtime image's Debian release (trixie is Debian 13): the binaries link
# against its glibc.
FROM docker.io/library/rust:1.99-trixie@sha256:8a4e90c7946b74626488b1446f712c0fe0ed1a596cbd3d871684bc9c5433ae07 AS build

WORKDIR /src

COPY Cargo.toml Cargo.lock rustfmt.toml rust-toolchain.toml ./
COPY crates crates

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin timba-oracle --bin timba-evm-oracle && \
    install -D -m 0755 -t /out target/release/timba-oracle target/release/timba-evm-oracle

# Distroless: glibc, libgcc, CA roots and tzdata only. No shell or package manager, so an
# exploit gets no tools, and health checks must use the exec form.
FROM gcr.io/distroless/cc-debian13@sha256:e1f5543d45a2cd7c02a5b43dda5f0ff30729b4832113759d01ed39b0b152cddb

# Relative defaults (oracle.sqlite, admin-keypair.json) resolve here.
WORKDIR /app

COPY --from=build /out/ /usr/local/bin/

# Expose default port (can be overridden by ORACLE_PORT)
EXPOSE 3001

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision="${VCS_REF}"

CMD ["timba-oracle", "serve"]
