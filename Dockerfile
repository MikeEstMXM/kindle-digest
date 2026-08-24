# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

# Build deps for native modules (better-sqlite3) + runtime libs for sharp.
# fonts-liberation provides Liberation Serif/Sans as fallback for SVG cover overlay.
# libjemalloc2: sharp/libvips allocate and free large short-lived buffers, and
# glibc's allocator holds the freed chunks in per-arena free lists rather than
# returning them, so peak RSS climbed with fragmentation. Measured ~40 MB lower
# peak on a 320-article digest at the default build concurrency.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates fonts-liberation libjemalloc2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (cached on lockfile changes).
COPY package.json package-lock.json* ./
RUN npm ci

# Build the app.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Download + embed the cover fonts into assets/fonts (self-contained EPUBs).
RUN npm run fetch-fonts

# Default runtime config. Override secrets via Fly secrets / env.
# LD_PRELOAD replaces glibc malloc wholesale, which supersedes the earlier
# MALLOC_ARENA_MAX=2 workaround (a glibc-only knob jemalloc ignores).
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/kindle-digest.sqlite \
    DIGEST_DIR=/data/digests \
    LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "dist/index.js"]
