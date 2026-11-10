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

# calibre — used only as a separate CLI process (`ebook-convert`) to turn the
# EPUB into a Kindle periodical MOBI; never imported (keeps its GPL code out of
# the app). The libs are what its bundled Qt needs to start headless; xz-utils
# and wget are for the installer. The installer verifies its download against
# calibre's published sha512 and `version=` pins the release, so a rebuild does
# not silently pick up a newer calibre. This layer sits above the app code so
# ordinary code changes don't re-download it.
ARG CALIBRE_VERSION=9.18.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    libegl1 libopengl0 libxkbcommon0 libglx0 libnss3 libxcomposite1 libxdamage1 \
    libxrandr2 libxtst6 libxkbfile1 libfontconfig1 libgl1 libdbus-1-3 libxcb-cursor0 \
    xz-utils wget \
    && rm -rf /var/lib/apt/lists/* \
    && wget -nv -O- https://download.calibre-ebook.com/linux-installer.sh \
       | sh /dev/stdin install_dir=/opt isolated=y version=${CALIBRE_VERSION} \
    && /opt/calibre/ebook-convert --version \
    && rm -rf /tmp/calibre-installer-cache
ENV PATH=/opt/calibre:$PATH \
    QT_QPA_PLATFORM=offscreen

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
    KINDLE_DIR=/data/kindle \
    KINDLE_PORT=3100 \
    LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2

# 3000 = the app (dashboard; has no login of its own — keep it behind Access).
# 3100 = the Kindle page: issue list + .mobi downloads only, no login, LAN use.
EXPOSE 3000 3100
VOLUME ["/data"]

CMD ["node", "dist/index.js"]
