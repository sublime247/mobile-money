######################################################################
# mobile-money — Redis Module (ElastiCache Redis 7)
# Resources: ElastiCache subnet group, security group,
#            replication group (primary + one read replica)
######################################################################

locals {
  name_prefix = "${var.app_name}-${var.environment}"
}

# ---------------------------------------------------------------------------
# ElastiCache Subnet Group — private subnets
# ---------------------------------------------------------------------------
resource "aws_elasticache_subnet_group" "main" {
  name        = "${local.name_prefix}-redis-subnet-group"
  subnet_ids  = var.private_subnet_ids
  description = "Subnet group for ${local.name_prefix} Redis cluster"

  tags = {
    Name = "${local.name_prefix}-redis-subnet-group"
  }
}

# ---------------------------------------------------------------------------
# Security Group — ElastiCache Redis
# Only accept connections on port 6379 from the app security group
# ---------------------------------------------------------------------------
resource "aws_security_group" "redis" {
  name        = "${local.name_prefix}-redis-sg"
  description = "Security group for ${local.name_prefix} ElastiCache Redis"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Redis from app tier"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-redis-sg"
  }
}

# ---------------------------------------------------------------------------
# ElastiCache Replication Group — Redis 7, automatic failover
# ---------------------------------------------------------------------------
resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.name_prefix}-redis"
  description          = "Redis 7 replication group for ${local.name_prefix}"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.node_type
  port           = 6379

  # Single shard, one primary + one read replica (disable for dev to save cost)
  num_cache_clusters         = var.environment == "prod" ? 2 : 1
  automatic_failover_enabled = var.environment == "prod" ? true : false
  multi_az_enabled           = var.environment == "prod" ? true : false

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  # Encryption
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  # Maintenance & snapshots
  snapshot_retention_limit = var.environment == "prod" ? 7 : 1
  snapshot_window          = "05:00-06:00"
  maintenance_window       = "sun:06:00-sun:07:00"

  # Apply changes immediately in non-prod
  apply_immediately = var.environment != "prod"

  tags = {
    Name = "${local.name_prefix}-redis"
  }
}
