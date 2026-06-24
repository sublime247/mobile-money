# =============================================================================
# Stage 1: Build - Compile TypeScript
# =============================================================================
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# =============================================================================
# Stage 2: Dependencies - Install ONLY production modules
# =============================================================================
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# =============================================================================
# Stage 3: Production Runtime - Minimal final image
# =============================================================================
FROM node:20-alpine AS production
ENV NODE_ENV=production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy ONLY what is strictly necessary from the previous stages
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./

# Manually remove npm and yarn binaries
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -rf /usr/local/bin/npm \
    && rm -rf /usr/local/bin/npx \
    && rm -rf /opt/yarn-* \
    && rm -rf /usr/local/bin/yarn \
    && rm -rf /usr/local/bin/yarnpkg

# Switch to non-root user
USER nodejs

EXPOSE 3001

# Direct node execution (no npm start wrapper)
CMD ["node", "dist/index.js"]
