# ──────────────────────────────────────────────────────────────────────────────
# Redis Module – ElastiCache Redis 7
# Managed Redis cluster matching the project's existing Redis 7 usage.
# Used for distributed locks, session caching, and rate limiting.
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.project}-${var.environment}-redis-subnet"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name        = "${var.project}-${var.environment}-redis-subnet"
    Environment = var.environment
  }
}

resource "aws_elasticache_parameter_group" "redis" {
  name   = "${var.project}-${var.environment}-redis7-params"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  tags = {
    Name        = "${var.project}-${var.environment}-redis-params"
    Environment = var.environment
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.project}-${var.environment}-redis"
  description          = "Redis cluster for ${var.project} ${var.environment}"

  # Engine
  engine               = "redis"
  engine_version       = "7.0"
  node_type            = var.redis_node_type
  parameter_group_name = aws_elasticache_parameter_group.redis.name

  # Cluster topology
  num_cache_clusters = var.redis_num_cache_clusters

  # Network
  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [var.security_group_id]
  port               = 6379

  # Reliability
  automatic_failover_enabled = var.redis_num_cache_clusters > 1
  multi_az_enabled           = var.redis_num_cache_clusters > 1
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false # keep false to match redis:// (non-TLS) connection strings

  # Maintenance
  maintenance_window       = "sun:05:00-sun:06:00"
  snapshot_retention_limit = var.environment == "production" ? 7 : 1
  snapshot_window          = "02:00-03:00"

  tags = {
    Name        = "${var.project}-${var.environment}-redis"
    Environment = var.environment
  }
}
