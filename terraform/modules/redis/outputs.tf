output "redis_primary_endpoint" {
  description = "Primary endpoint address of the ElastiCache replication group."
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "redis_port" {
  description = "Port of the Redis cluster."
  value       = aws_elasticache_replication_group.main.port
}

output "redis_security_group_id" {
  description = "ID of the Redis security group."
  value       = aws_security_group.redis.id
}
