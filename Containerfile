FROM docker.io/oven/bun:1.4.1@sha256:9e123d5fc069e29d519fd4c981afb61b8542ac80274771961136db1e4538d53e

WORKDIR /app

# Copy dependency manifests first for better caching
COPY package.json bun.lock .npmrc ./

# Install dependencies using the exact lockfile
RUN --mount=type=secret,id=npm_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)" bun install --frozen-lockfile

# Optional candidate package for cross-repository protocol PR validation.
# The default production build uses only the frozen registry dependency.
RUN --mount=type=secret,id=protocol_package --mount=type=secret,id=npm_token \
    if [ -s /run/secrets/protocol_package ]; then \
      cp /run/secrets/protocol_package /tmp/protocol.tgz && \
      NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)" bun add /tmp/protocol.tgz && rm /tmp/protocol.tgz; \
    fi

# Copy the rest of the application source
COPY . .

# Expose default port (can be overridden by ORACLE_PORT)
EXPOSE 3001

# Start the oracle API
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision="${VCS_REF}"

CMD ["bun", "start"]
