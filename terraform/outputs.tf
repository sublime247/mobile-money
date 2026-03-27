######################################################################
# mobile-money — Root Outputs
######################################################################

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer — use this as your app's public endpoint."
  value       = module.web.alb_dns_name
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster."
  value       = module.web.ecs_cluster_name
}

output "ecs_service_name" {
  description = "Name of the ECS service."
  value       = module.web.ecs_service_name
}

output "database_endpoint" {
  description = "RDS PostgreSQL endpoint (host:port)."
  value       = module.database.db_endpoint
}

output "database_url" {
  description = "Full PostgreSQL connection URL (sensitive — contains password)."
  value       = "postgresql://${var.db_username}:${var.db_password}@${module.database.db_endpoint}/${var.db_name}"
  sensitive   = true
}

output "redis_primary_endpoint" {
  description = "ElastiCache Redis primary endpoint hostname."
  value       = module.redis.redis_primary_endpoint
}

output "redis_url" {
  description = "Full Redis connection URL."
  value       = "redis://${module.redis.redis_primary_endpoint}:${module.redis.redis_port}"
}

output "vpc_id" {
  description = "ID of the provisioned VPC."
  value       = module.networking.vpc_id
}
