FROM oven/bun:1.3.1

WORKDIR /app

# Copy dependency manifests first for better caching
COPY package.json bun.lock ./

# Install dependencies using the exact lockfile
RUN bun install --frozen-lockfile

# Copy the rest of the application source
COPY . .

# Expose default port (can be overridden by ORACLE_PORT)
EXPOSE 3001

# Start the oracle API
CMD ["bun", "start"]
