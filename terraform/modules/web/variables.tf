variable "project" {
  description = "Project name used for resource naming"
  type        = string
}

variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for the ALB"
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks"
  type        = list(string)
}

variable "alb_security_group_id" {
  description = "Security group ID for the ALB"
  type        = string
}

variable "app_security_group_id" {
  description = "Security group ID for the application"
  type        = string
}

variable "app_port" {
  description = "Port the application container listens on"
  type        = number
  default     = 3000
}

variable "container_image" {
  description = "Docker image for the application (e.g. ECR URI)"
  type        = string
  default     = "shantelpeters/mobile-money:latest"
}

variable "task_cpu" {
  description = "CPU units for the ECS task (1024 = 1 vCPU)"
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Memory in MB for the ECS task"
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Desired number of running tasks"
  type        = number
  default     = 2
}

variable "max_count" {
  description = "Maximum number of tasks for auto-scaling"
  type        = number
  default     = 10
}

variable "database_url" {
  description = "PostgreSQL connection URL"
  type        = string
  sensitive   = true
}

variable "redis_url" {
  description = "Redis connection URL"
  type        = string
}

variable "s3_bucket_name" {
  description = "S3 bucket name for KYC document uploads"
  type        = string
  default     = "mobile-money-kyc-documents"
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}
