variable "app_name" {
  description = "Application name prefix."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)."
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC."
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for the ElastiCache subnet group."
  type        = list(string)
}

variable "node_type" {
  description = "ElastiCache node type (e.g. cache.t4g.micro)."
  type        = string
  default     = "cache.t4g.micro"
}

variable "app_security_group_id" {
  description = "Security group ID of the application tier (allowed to reach port 6379)."
  type        = string
}
