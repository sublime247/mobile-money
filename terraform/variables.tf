######################################################################
# mobile-money — Root Variables
######################################################################

# ---------------------------------------------------------------------------
# General
# ---------------------------------------------------------------------------
variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (e.g. dev, staging, prod)."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "app_name" {
  description = "Short application name used as a resource-name prefix."
  type        = string
  default     = "mobile-money"
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------
variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

# ---------------------------------------------------------------------------
# Database (RDS PostgreSQL)
# ---------------------------------------------------------------------------
variable "db_name" {
  description = "Name of the PostgreSQL database to create."
  type        = string
  default     = "mobilemoney_stellar"
}

variable "db_username" {
  description = "Master username for the RDS instance."
  type        = string
  default     = "mmadmin"
}

variable "db_password" {
  description = "Master password for the RDS instance. Set via TF_VAR_db_password or a .tfvars file — never hard-code."
  type        = string
  sensitive   = true
}

variable "db_instance_class" {
  description = "RDS instance type."
  type        = string
  default     = "db.t4g.micro"
}

# ---------------------------------------------------------------------------
# Redis (ElastiCache)
# ---------------------------------------------------------------------------
variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

# ---------------------------------------------------------------------------
# Web / ECS
# ---------------------------------------------------------------------------
variable "app_image" {
  description = "Docker image for the application (repo:tag)."
  type        = string
  default     = "shantelpeters/mobile-money:latest"
}

variable "app_count" {
  description = "Number of ECS task replicas to run."
  type        = number
  default     = 3
}

variable "app_port" {
  description = "Container port the application listens on."
  type        = number
  default     = 3000
}

variable "cpu" {
  description = "Fargate task CPU units (256, 512, 1024, 2048, 4096)."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 1024
}
