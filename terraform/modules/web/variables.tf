variable "app_name" {
  description = "Application name prefix."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)."
  type        = string
}

variable "aws_region" {
  description = "AWS region (used for CloudWatch Logs configuration)."
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for the ALB."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks."
  type        = list(string)
}

variable "app_image" {
  description = "Docker image for the application (repo:tag)."
  type        = string
}

variable "app_count" {
  description = "Desired number of ECS task replicas."
  type        = number
  default     = 3
}

variable "app_port" {
  description = "Container port the application listens on."
  type        = number
  default     = 3000
}

variable "cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 1024
}

variable "db_url" {
  description = "Full PostgreSQL DATABASE_URL connection string."
  type        = string
  sensitive   = true
}

variable "redis_url" {
  description = "Full Redis REDIS_URL connection string."
  type        = string
}

variable "db_security_group_id" {
  description = "Security group ID of the RDS instance (used for dependency tracking)."
  type        = string
}

variable "redis_security_group_id" {
  description = "Security group ID of the ElastiCache cluster (used for dependency tracking)."
  type        = string
}
