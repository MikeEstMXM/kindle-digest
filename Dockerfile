# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

# Build deps for native modules (better-sqlite3) + runtime libs for sharp.
# calibre: ebook-convert for periodical EPUB generation.
# fonts-liberation: SVG cover overlay fallback fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates fonts-liberation calibre \
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
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/kindle-digest.sqlite \
    CALIBRE_NO_NATIVE_DISPLAY=1

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "dist/index.js"]
