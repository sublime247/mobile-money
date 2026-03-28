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
