variable "project" {
  description = "Project name used for resource naming"
  type        = string
}

variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID to create security groups in"
  type        = string
}

variable "app_port" {
  description = "Port the application container listens on"
  type        = number
  default     = 3000
}
