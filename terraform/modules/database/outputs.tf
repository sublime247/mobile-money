output "db_endpoint" {
  description = "RDS instance endpoint (host:port)."
  value       = aws_db_instance.main.endpoint
}

output "db_port" {
  description = "RDS instance port."
  value       = aws_db_instance.main.port
}

output "db_name" {
  description = "Name of the created database."
  value       = aws_db_instance.main.db_name
}

output "db_security_group_id" {
  description = "ID of the RDS security group."
  value       = aws_security_group.rds.id
}
