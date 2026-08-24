# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

# Build deps for native modules (better-sqlite3) + runtime libs for sharp.
# fonts-liberation is the last-resort fallback for the SVG cover overlay; the
# cover's own faces are shipped in assets/fonts and registered with fontconfig
# at runtime by src/cover/fontconfig.ts.
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
# The cover fonts (woff2 for the EPUB, ttf for fontconfig/metrics) are committed,
# so they ship with the image instead of being re-fetched from a third-party
# host on every build — which made deploys depend on gwfh.mranftl.com being up
# and let the deployed bytes drift from the committed ones.
COPY assets ./assets
RUN npm run build

# Safety net only: with assets/ copied above every face is already present, so
# this skips all nine and makes no network calls.
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
