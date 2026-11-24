# ──────────────────────────────────────────────────────────────────────────────
# Root Outputs
# ──────────────────────────────────────────────────────────────────────────────

# ── Networking ─────────────────────────────────────────────────────────────
output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

# ── Load Balancer ──────────────────────────────────────────────────────────
output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer — point your domain here"
  value       = module.web.alb_dns_name
}

# ── Database ───────────────────────────────────────────────────────────────
output "db_endpoint" {
  description = "RDS PostgreSQL endpoint (host:port)"
  value       = module.database.db_endpoint
}

output "db_connection_url" {
  description = "Full PostgreSQL connection URL (sensitive)"
  value       = module.database.db_connection_url
  sensitive   = true
}

# ── Redis ──────────────────────────────────────────────────────────────────
output "redis_endpoint" {
  description = "ElastiCache Redis primary endpoint"
  value       = module.redis.redis_endpoint
}

output "redis_connection_url" {
  description = "Redis connection URL for the application"
  value       = module.redis.redis_connection_url
}

# ── ECS ────────────────────────────────────────────────────────────────────
output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = module.web.ecs_cluster_name
}

output "ecs_service_name" {
  description = "Name of the ECS service"
  value       = module.web.ecs_service_name
}

# ── S3 / KMS Replication ───────────────────────────────────────────────────
output "kyc_s3_primary_bucket_name" {
  description = "Primary KYC S3 bucket name"
  value       = module.s3.primary_bucket_name
}

output "kyc_s3_replica_bucket_name" {
  description = "Replica KYC S3 bucket name"
  value       = module.s3.replica_bucket_name
}

output "kyc_s3_primary_kms_alias_arn" {
  description = "Primary KMS alias ARN for KYC S3 SSE-KMS"
  value       = module.s3.primary_kms_alias_arn
}

output "kyc_s3_replica_kms_alias_arn" {
  description = "Replica KMS alias ARN for KYC S3 SSE-KMS"
  value       = module.s3.replica_kms_alias_arn
}
