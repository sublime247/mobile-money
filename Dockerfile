# =============================================================================
# Stage 1: builder — Compile TypeScript to JavaScript
# =============================================================================
FROM node:26-alpine AS builder
RUN apk upgrade --no-cache
WORKDIR /app

# Copy manifests first to leverage layer cache for npm ci
COPY package*.json ./

# Install ALL dependencies (including devDependencies) required for building
RUN npm ci --ignore-scripts

# Copy source (build context is trimmed by .dockerignore)
COPY . .

# Compile TypeScript → dist/
RUN npm run build

# =============================================================================
# Stage 2: deps — Install ONLY production modules, then aggressively prune
# =============================================================================
FROM node:26-alpine AS deps
RUN apk upgrade --no-cache
WORKDIR /app

COPY package*.json ./

ENV NODE_ENV=production

# Install production dependencies, then prune in a SINGLE RUN to minimize layer size.
# All removals in the same layer prevent deleted files from inflating the image.
RUN npm ci --omit=dev --legacy-peer-deps --ignore-scripts && \
    npm cache clean --force && \
    \
    # ── Prune text bloat (docs, type declarations, source maps, test suites) ──── \
    find ./node_modules -type f \( \
      -name "*.md" -o \
      -name "*.d.ts" -o \
      -name "*.map" -o \
      -name "CHANGELOG*" -o \
      -name "LICENCE*" -o \
      -name "LICENSE*" -o \
      -name "NOTICE*" -o \
      -name "AUTHORS*" -o \
      -name "CONTRIBUTORS*" \
    \) -delete && \
    find ./node_modules -type d \( \
      -name "test" -o \
      -name "tests" -o \
      -name "__tests__" -o \
      -name "example" -o \
      -name "examples" -o \
      -name "benchmark" -o \
      -name "benchmarks" -o \
      -name "coverage" -o \
      -name ".nyc_output" \
    \) -prune -exec rm -rf '{}' + && \
    \
    # ── Strip foreign OS / architecture binaries (Alpine uses musl x64) ────────── \
    find ./node_modules -type d \( \
      -name "darwin-x64"  -o \
      -name "darwin-arm64" -o \
      -name "win32-x64"   -o \
      -name "win32-ia32"  -o \
      -name "win32-arm64" -o \
      -name "linuxglibc-x64"   -o \
      -name "linuxglibc-arm64" -o \
      -name "linux-arm64"  -o \
      -name "arm64" \
    \) -prune -exec rm -rf '{}' + && \
    \
    # ── sharp/libvips: Alpine uses musl — drop glibc Linux builds ───────────────── \
    rm -rf ./node_modules/@img/sharp-linux-x64 \
           ./node_modules/@img/sharp-libvips-linux-x64 && \
    \
    # ── GeoIP databases: keep only IPv4 country file (~3 MB) ───────────────────── \
    rm -f ./node_modules/geoip-lite/data/geoip-city.dat \
          ./node_modules/geoip-lite/data/geoip-city-names.dat \
          ./node_modules/geoip-lite/data/geoip-city6.dat \
          ./node_modules/geoip-lite/data/geoip-country6.dat \
          ./node_modules/geoip-lite/data/*.checksum && \
    \
    # ── Remove dev-only packages that somehow landed in prod tree ──────────────── \
    rm -rf ./node_modules/wrangler \
           ./node_modules/@cloudflare \
           ./node_modules/@esbuild \
           ./node_modules/typescript

# =============================================================================
# Stage 3: production — Minimal Alpine runtime image
# =============================================================================
FROM node:26-alpine AS production
RUN apk upgrade --no-cache

ENV NODE_ENV=production

# Non-root user for least-privilege execution
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nodejs -u 1001 -G nodejs

WORKDIR /app

# Copy pruned production node_modules from deps stage
COPY --from=deps    --chown=nodejs:nodejs /app/node_modules   ./node_modules

# Copy compiled application from builder stage
COPY --from=builder --chown=nodejs:nodejs /app/dist           ./dist

# Copy runtime assets
COPY --from=builder --chown=nodejs:nodejs /app/package.json   ./package.json
COPY --chown=nodejs:nodejs                public               ./public

# Remove the package managers bundled with the node base image —
# the container only needs `node` at runtime.
RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /opt/yarn-* \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg

# Persistent log directory owned by the app user
RUN mkdir -p /app/logs && chown nodejs:nodejs /app/logs

USER nodejs

EXPOSE 3000

# Run directly with node — no npm/shell wrapper overhead
CMD ["node", "dist/src/index.js"]
