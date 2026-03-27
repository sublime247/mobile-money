variable "app_name" {
  description = "Application name prefix."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)."
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC to place the RDS instance in."
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for the DB subnet group."
  type        = list(string)
}

variable "db_name" {
  description = "Name of the database to create."
  type        = string
}

variable "db_username" {
  description = "Master username for the RDS instance."
  type        = string
}

variable "db_password" {
  description = "Master password for the RDS instance (sensitive)."
  type        = string
  sensitive   = true
}

variable "db_instance_class" {
  description = "RDS instance type."
  type        = string
  default     = "db.t4g.micro"
}

variable "app_security_group_id" {
  description = "Security group ID of the application tier (allowed to reach port 5432)."
  type        = string
}
