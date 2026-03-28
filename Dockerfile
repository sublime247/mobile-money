# =============================================================================
# Build Stage - Compile TypeScript and install dependencies
# =============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install all dependencies (including devDependencies for build)
COPY package*.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY . .
RUN npm run build

# Prune devDependencies after build
RUN npm prune --production

# =============================================================================
# Production Stage - Minimal runtime image
# =============================================================================
FROM node:20-alpine AS production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy only production dependencies from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy only compiled JavaScript (not TypeScript source)
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./

# Remove unnecessary tools from final image
RUN apk del --no-cache npm && \
    rm -rf /root/.npm /tmp/*

# Switch to non-root user
USER nodejs

EXPOSE 3000

# Direct node execution (no npm wrapper)
CMD ["node", "dist/index.js"]
