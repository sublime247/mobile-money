output "redis_endpoint" {
  description = "Primary endpoint for the Redis replication group"
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "redis_port" {
  description = "Redis port"
  value       = 6379
}

output "redis_connection_url" {
  description = "Redis connection URL for the application"
  value       = "redis://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
}
