variable "project" {
  description = "Project name used for resource naming"
  type        = string
}

variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for the ElastiCache subnet group (must span multiple AZs for Multi-AZ)"
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group ID for Redis"
  type        = string
}

variable "redis_node_type" {
  description = "ElastiCache node instance type"
  type        = string
  default     = "cache.t3.micro"
}

variable "redis_num_cache_clusters" {
  description = "Number of cache cluster nodes (must be >= 2 for Multi-AZ failover)"
  type        = number
  default     = 2
  validation {
    condition     = var.redis_num_cache_clusters >= 1
    error_message = "Number of cache clusters must be at least 1."
  }
}

variable "notification_email" {
  description = "Email address for Redis failover notifications"
  type        = string
  default     = ""
}

variable "maintenance_window" {
  description = "Maintenance window for Redis updates"
  type        = string
  default     = "sun:05:00-sun:06:00"
}

variable "snapshot_window" {
  description = "Snapshot window for Redis backups"
  type        = string
  default     = "02:00-03:00"
}
