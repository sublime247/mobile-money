output "redis_endpoint" {
  description = "Primary endpoint for the Redis replication group"
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "redis_reader_endpoint" {
  description = "Reader endpoint for read-only operations across replicas (available when Multi-AZ is enabled)"
  value       = try(aws_elasticache_replication_group.main.reader_endpoint_address, "")
}

output "redis_port" {
  description = "Redis port"
  value       = 6379
}

output "redis_connection_url" {
  description = "Redis connection URL for the application"
  value       = "redis://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
}

output "redis_replication_group_id" {
  description = "Redis replication group ID"
  value       = aws_elasticache_replication_group.main.id
}

output "redis_member_clusters" {
  description = "List of member clusters in the replication group"
  value       = aws_elasticache_replication_group.main.member_clusters
}

output "redis_automatic_failover_enabled" {
  description = "Whether automatic failover is enabled"
  value       = aws_elasticache_replication_group.main.automatic_failover_enabled
}

output "redis_multi_az_enabled" {
  description = "Whether Multi-AZ is enabled"
  value       = aws_elasticache_replication_group.main.multi_az_enabled
}

output "redis_notification_topic_arn" {
  description = "SNS topic ARN for Redis failover notifications"
  value       = aws_sns_topic.redis_failover.arn
}

output "redis_slow_log_group" {
  description = "CloudWatch log group for Redis slow logs"
  value       = aws_cloudwatch_log_group.redis_slow_log.name
}

output "redis_engine_log_group" {
  description = "CloudWatch log group for Redis engine logs"
  value       = aws_cloudwatch_log_group.redis_engine_log.name
}
