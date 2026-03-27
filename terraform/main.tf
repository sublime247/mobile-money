######################################################################
# mobile-money — Root Terraform Module
# Cloud: AWS
# Provisions: VPC/Subnets, RDS PostgreSQL, ElastiCache Redis,
#             ECS Fargate cluster + Application Load Balancer
######################################################################

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # ---------------------------------------------------------------------------
  # Remote state — S3 backend with DynamoDB locking.
  # Uncomment and fill in once you have created the bucket + table.
  # ---------------------------------------------------------------------------
  # backend "s3" {
  #   bucket         = "mobile-money-tfstate-<account-id>"
  #   key            = "envs/<env>/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "mobile-money-tfstate-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.app_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# ---------------------------------------------------------------------------
# Data sources
# ---------------------------------------------------------------------------
data "aws_availability_zones" "available" {
  state = "available"
}

# ---------------------------------------------------------------------------
# Networking — VPC, subnets, IGW, NAT gateways, route tables
# ---------------------------------------------------------------------------
module "networking" {
  source = "./modules/networking"

  app_name           = var.app_name
  environment        = var.environment
  vpc_cidr           = var.vpc_cidr
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 3)
}

# ---------------------------------------------------------------------------
# Database — RDS PostgreSQL 16
# ---------------------------------------------------------------------------
module "database" {
  source = "./modules/database"

  app_name              = var.app_name
  environment           = var.environment
  vpc_id                = module.networking.vpc_id
  private_subnet_ids    = module.networking.private_subnet_ids
  db_name               = var.db_name
  db_username           = var.db_username
  db_password           = var.db_password
  db_instance_class     = var.db_instance_class
  app_security_group_id = module.web.app_security_group_id
}

# ---------------------------------------------------------------------------
# Redis — ElastiCache Redis 7
# ---------------------------------------------------------------------------
module "redis" {
  source = "./modules/redis"

  app_name              = var.app_name
  environment           = var.environment
  vpc_id                = module.networking.vpc_id
  private_subnet_ids    = module.networking.private_subnet_ids
  node_type             = var.redis_node_type
  app_security_group_id = module.web.app_security_group_id
}

# ---------------------------------------------------------------------------
# Web / Application — ECS Fargate + ALB
# ---------------------------------------------------------------------------
module "web" {
  source = "./modules/web"

  app_name           = var.app_name
  environment        = var.environment
  aws_region         = var.aws_region
  vpc_id             = module.networking.vpc_id
  public_subnet_ids  = module.networking.public_subnet_ids
  private_subnet_ids = module.networking.private_subnet_ids
  app_image          = var.app_image
  app_count          = var.app_count
  app_port           = var.app_port
  cpu                = var.cpu
  memory             = var.memory

  # Runtime environment — injected as container env vars
  db_url    = "postgresql://${var.db_username}:${var.db_password}@${module.database.db_endpoint}/${var.db_name}"
  redis_url = "redis://${module.redis.redis_primary_endpoint}:${module.redis.redis_port}"

  db_security_group_id    = module.database.db_security_group_id
  redis_security_group_id = module.redis.redis_security_group_id
}
