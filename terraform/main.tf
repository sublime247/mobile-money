# ──────────────────────────────────────────────────────────────────────────────
# Mobile Money – Terraform Root Configuration
# Orchestrates all infrastructure modules in the correct dependency order:
#   VPC → Security Groups → Database + Redis → Web Cluster
# ──────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state — uncomment and configure for your team
  # backend "s3" {
  #   bucket         = "mobile-money-terraform-state"
  #   key            = "infra/terraform.tfstate"
  #   region         = "us-east-1"
  #   encrypt        = true
  #   dynamodb_table = "terraform-locks"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# ── 1. Networking ──────────────────────────────────────────────────────────
module "vpc" {
  source = "./modules/vpc"

  project     = var.project
  environment = var.environment
  vpc_cidr    = var.vpc_cidr
  az_count    = var.az_count
}

# ── 2. Security Groups ────────────────────────────────────────────────────
module "security" {
  source = "./modules/security"

  project     = var.project
  environment = var.environment
  vpc_id      = module.vpc.vpc_id
  app_port    = var.app_port
}

# ── 3. Managed Database (RDS PostgreSQL) ──────────────────────────────────
module "database" {
  source = "./modules/database"

  project              = var.project
  environment          = var.environment
  private_subnet_ids   = module.vpc.private_subnet_ids
  security_group_id    = module.security.database_security_group_id
  db_instance_class    = var.db_instance_class
  db_allocated_storage = var.db_allocated_storage
  db_name              = var.db_name
  db_username          = var.db_username
  db_password          = var.db_password
  db_multi_az          = var.db_multi_az
}

# ── 4. Managed Redis (ElastiCache) ────────────────────────────────────────
module "redis" {
  source = "./modules/redis"

  project                  = var.project
  environment              = var.environment
  private_subnet_ids       = module.vpc.private_subnet_ids
  security_group_id        = module.security.redis_security_group_id
  redis_node_type          = var.redis_node_type
  redis_num_cache_clusters = var.redis_num_cache_clusters
}

# ── 5. Web Cluster (ECS Fargate + ALB) ────────────────────────────────────
module "web" {
  source = "./modules/web"

  project               = var.project
  environment           = var.environment
  vpc_id                = module.vpc.vpc_id
  public_subnet_ids     = module.vpc.public_subnet_ids
  private_subnet_ids    = module.vpc.private_subnet_ids
  alb_security_group_id = module.security.alb_security_group_id
  app_security_group_id = module.security.app_security_group_id
  app_port              = var.app_port
  container_image       = var.container_image
  task_cpu              = var.task_cpu
  task_memory           = var.task_memory
  desired_count         = var.desired_count
  max_count             = var.max_count
  database_url          = module.database.db_connection_url
  redis_url             = module.redis.redis_connection_url
  s3_bucket_name        = var.s3_bucket_name
}
