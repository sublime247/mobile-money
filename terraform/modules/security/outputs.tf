output "alb_security_group_id" {
  description = "Security group ID for the ALB"
  value       = aws_security_group.alb.id
}

output "app_security_group_id" {
  description = "Security group ID for the application"
  value       = aws_security_group.app.id
}

output "database_security_group_id" {
  description = "Security group ID for the database"
  value       = aws_security_group.database.id
}

output "redis_security_group_id" {
  description = "Security group ID for Redis"
  value       = aws_security_group.redis.id
}
