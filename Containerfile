# Keep this on the runtime image's Debian release (trixie is Debian 13): the binaries link
# against its glibc.
FROM docker.io/library/rust:1.100-trixie@sha256:e19840879045c951c905d0eaa9887f3439c62000e429963371b376bac8d38c31 AS build

WORKDIR /src

COPY Cargo.toml Cargo.lock rustfmt.toml rust-toolchain.toml ./
COPY crates crates

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin timba-oracle --bin timba-evm-oracle && \
    install -D -m 0755 -t /out target/release/timba-oracle target/release/timba-evm-oracle

# Distroless: glibc, libgcc, CA roots and tzdata only. No shell or package manager, so an
# exploit gets no tools, and health checks must use the exec form.
FROM gcr.io/distroless/cc-debian13@sha256:809d04afa1be033c441f76bb0051878c342fb76d0ea236bc6dc94b655fa0fbd6

# Relative defaults (oracle.sqlite, admin-keypair.json) resolve here.
WORKDIR /app

COPY --from=build /out/ /usr/local/bin/

# Expose default port (can be overridden by ORACLE_PORT)
EXPOSE 3001

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision="${VCS_REF}"

CMD ["timba-oracle", "serve"]
