# ──────────────────────────────────────────────────────────────────────────────
# Root Variables
# ──────────────────────────────────────────────────────────────────────────────

# ── General ────────────────────────────────────────────────────────────────
variable "project" {
  description = "Project name, used as prefix for all resource names"
  type        = string
  default     = "mobile-money"
}

variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be 'staging' or 'production'."
  }
}

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

# ── Networking ─────────────────────────────────────────────────────────────
variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones to use"
  type        = number
  default     = 2
}

# ── Application ────────────────────────────────────────────────────────────
variable "app_port" {
  description = "Port the application listens on"
  type        = number
  default     = 3000
}

variable "container_image" {
  description = "Docker image URI for the application"
  type        = string
  default     = "shantelpeters/mobile-money:latest"
}

variable "task_cpu" {
  description = "CPU units for each ECS task (256 = 0.25 vCPU)"
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Memory in MB for each ECS task"
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Desired number of running ECS tasks"
  type        = number
  default     = 2
}

variable "max_count" {
  description = "Maximum number of ECS tasks for auto-scaling"
  type        = number
  default     = 10
}

# ── Database ───────────────────────────────────────────────────────────────
variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"
}

variable "db_allocated_storage" {
  description = "Initial storage allocation in GB"
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Name of the PostgreSQL database"
  type        = string
  default     = "mobilemoney_stellar"
}

variable "db_username" {
  description = "Database master username"
  type        = string
  default     = "mobilemoney"
  sensitive   = true
}

variable "db_password" {
  description = "Database master password"
  type        = string
  sensitive   = true
}

variable "db_multi_az" {
  description = "Enable Multi-AZ for the RDS instance"
  type        = bool
  default     = false
}

# ── Redis ──────────────────────────────────────────────────────────────────
variable "redis_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.t3.micro"
}

variable "redis_num_cache_clusters" {
  description = "Number of Redis cache nodes (>1 enables automatic failover)"
  type        = number
  default     = 1
}

# ── S3 ─────────────────────────────────────────────────────────────────────
variable "s3_bucket_name" {
  description = "S3 bucket for KYC document uploads"
  type        = string
  default     = "mobile-money-kyc-documents"
}
