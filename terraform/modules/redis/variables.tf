variable "project" {
  description = "Project name used for resource naming"
  type        = string
}

variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for the ElastiCache subnet group"
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
  description = "Number of cache cluster nodes (>1 enables failover)"
  type        = number
  default     = 1
}
