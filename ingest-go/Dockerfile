# =============================================================================
# Stage 1: Build - Compile Go binary
# =============================================================================
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Copy modules manifests
COPY go.mod ./

# Download dependencies
RUN go mod download

# Copy source code
COPY main.go ./

# Compile Go binary statically with optimizations
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o ingest-go main.go

# =============================================================================
# Stage 2: Production Runtime - Minimal final image
# =============================================================================
FROM alpine:3.19 AS production

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy compiled binary from builder
COPY --from=builder --chown=appuser:appgroup /app/ingest-go ./ingest-go

# Switch to non-root user
USER appuser

EXPOSE 3002

# Run Go application
CMD ["./ingest-go"]
