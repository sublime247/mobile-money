# Optimized Worker Bundle

This directory contains the esbuild configuration for optimized worker bundle builds.

## Quick Start

### Install Dependencies

```bash
npm install
```

### Build Options

```bash
# Development build (with sourcemaps)
npm run build:optimized

# Production build (minified, tree-shaked)
npm run build:prod

# Traditional TypeScript build
npm run build
```

## Build Comparison

| Build Type | Command | Sourcemaps | Minified | Tree-shaking |
|------------|---------|------------|----------|--------------|
| Development | `npm run build:optimized` | ✅ | ❌ | ✅ |
| Production | `npm run build:prod` | ❌ | ✅ | ✅ |
| Traditional | `npm run build` | ✅ | ❌ | ❌ |

## Bundle Analysis

The build script includes bundle analysis that shows:
- Total bundle size
- Individual module sizes
- Dependencies included
- Tree-shaking effectiveness

## Configuration

The esbuild configuration is in `esbuild.config.js`. Key settings:

- **Platform:** Node.js 18
- **Format:** CommonJS (for Node.js compatibility)
- **External dependencies:** Fastify, ioredis, nats, prom-client, zod
- **Tree-shaking:** Enabled for all builds
- **Minification:** Enabled only for production builds

## Performance Benefits

### Before (TypeScript compiler)
- Slow build times
- No tree-shaking
- Large bundle size
- Multiple output files

### After (esbuild)
- ⚡ 10-100x faster builds
- 🌳 Tree-shaking removes unused code
- 📦 Single optimized bundle
- 🔍 Sourcemaps for debugging

## Troubleshooting

### Build fails with missing dependencies

```bash
# Install esbuild
npm install --save-dev esbuild

# Or use the existing package.json
npm install
```

### Sourcemaps not working

Make sure you're using the development build:
```bash
npm run build:optimized
```

### Bundle size too large

Check the bundle analysis output to identify large dependencies:
```bash
npm run build:optimized
```

## Integration

### CI/CD Pipeline

```yaml
# GitHub Actions example
- name: Build optimized bundle
  run: |
    cd ingest-node
    npm install
    npm run build:prod
```

### Docker

```dockerfile
# Multi-stage build
FROM node:18-alpine AS builder
WORKDIR /app
COPY ingest-node/package*.json ./
RUN npm ci
COPY ingest-node/ .
RUN npm run build:prod

FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
```