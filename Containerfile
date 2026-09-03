FROM docker.io/oven/bun:latest

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision="${VCS_REF}"

WORKDIR /app

# Copy dependency manifests first for better caching
COPY package.json bun.lock .npmrc ./

# Install dependencies using the exact lockfile
RUN --mount=type=secret,id=npm_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)" bun install --frozen-lockfile

# Copy the rest of the application source
COPY . .

# Expose default port (can be overridden by ORACLE_PORT)
EXPOSE 3001

# Start the oracle API
CMD ["bun", "start"]
