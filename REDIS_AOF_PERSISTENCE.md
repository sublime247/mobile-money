# Redis AOF Persistence Configuration

## Overview

Redis Append Only File (AOF) persistence has been configured for the Docker Compose development stack. This ensures that data is preserved across container restarts, preventing data loss during development.

## Configuration Files Modified

### 1. `redis.conf` (NEW)

- Created comprehensive Redis configuration file with AOF enabled
- Centralized configuration for consistent behavior across environments
- Optimized settings for development workloads

### 2. `docker-compose.yml`

- Updated Redis service to use `redis.conf` configuration file
- Added `redis_data` volume for persistent storage
- Improved healthcheck with timeout and retry settings

### 3. `docker-compose.dev.yml`

- Updated Redis service to use the same `redis.conf` configuration
- Replaced inline `--appendonly yes` command with config file approach
- Now consistent with main docker-compose.yml

## AOF Persistence Features

### What is AOF?

**Append Only File (AOF)** is a Redis persistence mechanism that:

- Logs every write operation received by the server
- Replays operations on startup to restore state
- Safer than RDB snapshots (captures intermediate changes)
- Better for data-critical applications

### Configuration Details

```conf
# AOF enabled by default
appendonly yes

# Filename for AOF
appendfilename "appendonly.aof"

# fsync policy: everysec (good balance)
appendfsync everysec
  - always: fsync after every write (safest, slowest)
  - everysec: fsync once per second (default, recommended)
  - no: let OS handle (fastest, less safe)

# Hybrid RDB-AOF format (Redis 7.0+)
aof-use-rdb-preamble yes
  - Combines benefits of both RDB and AOF
  - Faster startup and smaller file size
  - Better compatibility

# Auto-rewrite when file reaches 100% of previous size OR 64MB
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
```

## How It Works

### Data Persistence Flow

```
Redis Write Operation
         ↓
    Log to AOF file
         ↓
    fsync (everysec)
         ↓
    Disk storage
         ↓
Container Restart
         ↓
Replay AOF file
         ↓
Data restored
```

### Volume Mounting

```yaml
volumes:
  - ./redis.conf:/usr/local/etc/redis/redis.conf:ro # Config (read-only)
  - redis_data:/data # Persistence data
```

**Important**: The config is mounted read-only (`:ro`) to prevent accidental modification by the container.

## Data Storage

### Production (`docker-compose.yml`)

- Volume: `redis_data` (named Docker volume)
- Location: Managed by Docker at `/var/lib/docker/volumes/`
- Persists across container lifecycle
- Backed up separately

### Development (`docker-compose.dev.yml`)

- Volume: `redis_dev_data` (named Docker volume)
- Location: Managed by Docker
- Used during local development
- Can be cleaned with: `docker volume rm redis_dev_data`

## Verification

### Check AOF File Inside Container

```bash
# Connect to Redis container
docker exec -it mobilemoney_redis redis-cli

# Verify AOF is enabled
127.0.0.1:6379> CONFIG GET appendonly
1) "appendonly"
2) "yes"

# Check AOF filename
127.0.0.1:6379> CONFIG GET appendfilename
1) "appendfilename"
2) "appendonly.aof"

# View AOF size
127.0.0.1:6379> DEBUG OBJECT key_name
(or check file size with: docker exec mobilemoney_redis ls -lh /data/appendonly.aof)
```

### Docker Volume Location

```bash
# List volumes
docker volume ls | grep redis

# Inspect volume
docker volume inspect mobilemoney_redis_redis_data

# View persistent data location on host
docker volume inspect redis_data --format='{{.Mountpoint}}'
```

## Usage Examples

### Start Stack with Persistence

```bash
# Using docker-compose.yml
docker-compose up -d

# Using docker-compose.dev.yml (for development)
docker-compose -f docker-compose.dev.yml up -d
```

### Verify Data Persistence

```bash
# Write data
docker exec -it mobilemoney_redis redis-cli SET testkey "persistent value"

# Stop container (data persists in volume)
docker-compose down

# Start container
docker-compose up -d

# Verify data
docker exec -it mobilemoney_redis redis-cli GET testkey
# Returns: "persistent value"
```

### Clean Volume (if needed)

```bash
# Remove stack
docker-compose down

# Remove volume (WARNING: deletes all data)
docker volume rm mobilemoney_redis_redis_data

# Start fresh
docker-compose up -d
```

## Performance Considerations

### Memory Usage

- AOF file grows with every write operation
- Auto-rewrite triggered at 100% growth or 64MB
- Hybrid format reduces file size significantly

### Disk I/O

- `fsync everysec`: Write updates every second (good balance)
- No real-time write blocking
- Acceptable data loss: up to 1 second of writes

### Startup Time

- Hybrid RDB-AOF format provides faster startup
- Only affected by AOF rewrite frequency
- Typically negligible for development workloads

## Troubleshooting

### AOF Rewrite Issues

```bash
# Manually trigger AOF rewrite
docker exec -it mobilemoney_redis redis-cli BGREWRITEAOF
```

### Check AOF Status

```bash
# Inside redis-cli
127.0.0.1:6379> INFO persistence
# Shows aof_current_size, aof_base_size, etc.
```

### Verify Configuration Loaded

```bash
docker exec -it mobilemoney_redis redis-cli CONFIG GET appendonly
```

## Migration from Previous Setup

### Before (No Persistence)

- Every container restart lost all data
- Problematic for long-running dev tasks
- Queue data, sessions, etc. would be lost

### After (With AOF)

- Data persists across container restarts
- Queue items preserved
- Session data maintained
- Simulates production behavior

### No Action Required

- Upgrade is transparent
- First startup creates new `/data` volume
- Existing work unaffected (new persistence starts fresh)

## Related Documentation

- [Redis Persistence](https://redis.io/topics/persistence)
- [Docker Volumes](https://docs.docker.com/storage/volumes/)
- [Docker Compose](https://docs.docker.com/compose/)

## Security Notes

- Config file is mounted read-only `:ro` to prevent tampering
- AOF file contains actual data - handle with care in production
- Volume data persists even after `docker-compose down`
- For sensitive data, use Docker secrets management in production

## Summary

✅ **AOF Persistence Enabled**

- Data survives container restarts
- Consistent configuration across environments
- Optimized for development workloads
- No breaking changes to existing setup

**Key Benefits:**

- Data preservation across restarts
- Production-like behavior during development
- Minimal performance impact
- Easy volume cleanup if needed
