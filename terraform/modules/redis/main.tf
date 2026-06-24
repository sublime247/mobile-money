# ──────────────────────────────────────────────────────────────────────────────
# Redis Module – ElastiCache Redis 7 with Multi-AZ Failover Strategy
# Managed Redis cluster with automatic failover across multiple availability zones.
# Used for distributed locks, session caching, and rate limiting with high availability.
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

  parameter {
    name  = "timeout"
    value = "300"
  }

  parameter {
    name  = "tcp-keepalive"
    value = "60"
  }

  tags = {
    Name        = "${var.project}-${var.environment}-redis-params"
    Environment = var.environment
  }
}

resource "aws_sns_topic" "redis_failover" {
  name = "${var.project}-${var.environment}-redis-failover"

  tags = {
    Name        = "${var.project}-${var.environment}-redis-failover"
    Environment = var.environment
  }
}

resource "aws_sns_topic_subscription" "redis_failover_email" {
  topic_arn = aws_sns_topic.redis_failover.arn
  protocol  = "email"
  endpoint  = var.notification_email
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = "${var.project}-${var.environment}-redis"
  replication_group_description = "Redis cluster for ${var.project} ${var.environment} with Multi-AZ failover"

  # Engine
  engine               = "redis"
  engine_version       = "7.0"
  node_type            = var.redis_node_type
  parameter_group_name = aws_elasticache_parameter_group.redis.name

  # Cluster topology for Multi-AZ
  num_cache_clusters = var.redis_num_cache_clusters

  # Network
  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [var.security_group_id]
  port               = 6379

  # Multi-AZ Failover Strategy
  automatic_failover_enabled = true
  multi_az_enabled           = var.redis_num_cache_clusters > 1

  # Encryption
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false # keep false to match redis:// (non-TLS) connection strings
  auth_token_enabled         = false

  # Maintenance and backup
  maintenance_window       = var.maintenance_window
  snapshot_retention_limit = var.environment == "production" ? 7 : 1
  snapshot_window          = var.snapshot_window

  # Notifications
  notification_topic_arn = aws_sns_topic.redis_failover.arn

  # Logging
  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_slow_log.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
    enabled          = true
  }

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_engine_log.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "engine-log"
    enabled          = true
  }

  # Automatic failover and failover timeout
  automatic_failover_enabled = true

  # Apply immediately only for non-production environments
  apply_immediately = var.environment != "production"

  tags = {
    Name        = "${var.project}-${var.environment}-redis"
    Environment = var.environment
    Strategy    = "Multi-AZ-Failover"
  }

  depends_on = [
    aws_cloudwatch_log_group.redis_slow_log,
    aws_cloudwatch_log_group.redis_engine_log,
    aws_sns_topic.redis_failover
  ]
}

resource "aws_cloudwatch_log_group" "redis_slow_log" {
  name              = "/aws/elasticache/redis/${var.project}/${var.environment}/slow-log"
  retention_in_days = var.environment == "production" ? 30 : 7

  tags = {
    Name        = "${var.project}-${var.environment}-redis-slow-log"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "redis_engine_log" {
  name              = "/aws/elasticache/redis/${var.project}/${var.environment}/engine-log"
  retention_in_days = var.environment == "production" ? 30 : 7

  tags = {
    Name        = "${var.project}-${var.environment}-redis-engine-log"
    Environment = var.environment
  }
}
