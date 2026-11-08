# Crusonia iMessage bridge (Photon Spectrum <-> Crusonia Worker). Outbound-only: it publishes no port. The health
# server listens on 127.0.0.1 inside the container for the HEALTHCHECK and the operator CLI.
FROM oven/bun:1.4.4-slim

WORKDIR /app
ENV NODE_ENV=production
# The container runs with a read-only root filesystem (deploy/aws.sh): no transpiler cache on disk.
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

# Dependencies first for layer caching. Lifecycle scripts are not needed (protobufjs' postinstall is a version check).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

ENV PORT=8080
USER bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT}/health`); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "src/index.ts"]
