FROM oven/bun:latest

WORKDIR /app

# Copy sources
COPY . /app

# Install dependencies
RUN bun install

# Expose default port (can be overridden by ORACLE_PORT)
EXPOSE 3001

# Start the oracle API
CMD ["bun", "start"]

