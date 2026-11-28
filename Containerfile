# Keep this on the runtime image's Debian release (trixie is Debian 13): the binaries link
# against its glibc.
FROM docker.io/library/rust:1.100-trixie@sha256:e84068000361bf3d4a5ba2b7647f62893528b1eb9f847d7a23b493f5ce8ea254 AS build

WORKDIR /src

COPY Cargo.toml Cargo.lock rustfmt.toml rust-toolchain.toml ./
COPY crates crates

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin timba-oracle --bin timba-evm-oracle && \
    install -D -m 0755 -t /out target/release/timba-oracle target/release/timba-evm-oracle

# Distroless: glibc, libgcc, CA roots and tzdata only. No shell or package manager, so an
# exploit gets no tools, and health checks must use the exec form.
FROM gcr.io/distroless/cc-debian13@sha256:e8343d4a7da8bb210df0c3ea29de38bbadbba6c773bed0cd8bde506fca3a5c44

# Relative defaults (oracle.sqlite, admin-keypair.json) resolve here.
WORKDIR /app

COPY --from=build /out/ /usr/local/bin/

# Expose default port (can be overridden by ORACLE_PORT)
EXPOSE 3001

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision="${VCS_REF}"

CMD ["timba-oracle", "serve"]
