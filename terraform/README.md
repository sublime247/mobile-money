# Terraform Infrastructure — mobile-money

Provisions the full AWS infrastructure for **mobile-money** using Terraform.

```
AWS
├── VPC (10.0.0.0/16)
│   ├── 3 × Public Subnets   ── Internet Gateway → NAT Gateways
│   └── 3 × Private Subnets  ── app tasks, RDS, ElastiCache
├── RDS PostgreSQL 16        (Multi-AZ in prod, encrypted, automated backups)
├── ElastiCache Redis 7      (replication group, encrypted at-rest + in-transit)
└── ECS Fargate Cluster
    ├── Task Definition       (512 CPU / 1024 MiB, env vars injected)
    ├── ECS Service           (3 replicas, rolling deploy, CPU auto-scaling)
    └── ALB                   (public HTTP:80 → ECS tasks on port 3000)
```

## Prerequisites

| Tool | Version |
|------|---------|
| [Terraform](https://developer.hashicorp.com/terraform/downloads) | ≥ 1.5.0 |
| [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) | ≥ 2.x |
| AWS credentials | `~/.aws/credentials` or env vars |

## Quick Start

```bash
# 1. Clone and enter the terraform directory
cd terraform

# 2. Copy and fill in the variable file (never commit this file)
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars

# 3. Initialise providers and modules
terraform init

# 4. Preview changes
terraform plan

# 5. Apply
terraform apply
```

## Remote State (recommended for teams)

Uncomment the `backend "s3"` block in `main.tf` and create the S3 bucket + DynamoDB table first:

```bash
aws s3api create-bucket --bucket mobile-money-tfstate-<account-id> \
  --region us-east-1

aws dynamodb create-table \
  --table-name mobile-money-tfstate-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1
```

## Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `aws_region` | `us-east-1` | AWS region |
| `environment` | `dev` | `dev` / `staging` / `prod` |
| `app_name` | `mobile-money` | Resource name prefix |
| `vpc_cidr` | `10.0.0.0/16` | VPC CIDR block |
| `db_name` | `mobilemoney_stellar` | PostgreSQL DB name |
| `db_username` | `mmadmin` | RDS master username |
| `db_password` | *(required)* | RDS master password — **sensitive** |
| `db_instance_class` | `db.t4g.micro` | RDS instance type |
| `redis_node_type` | `cache.t4g.micro` | ElastiCache node type |
| `app_image` | `shantelpeters/mobile-money:latest` | Docker image |
| `app_count` | `3` | ECS desired task count |
| `app_port` | `3000` | Container port |
| `cpu` | `512` | Fargate CPU units |
| `memory` | `1024` | Fargate memory (MiB) |

## Outputs

| Output | Description |
|--------|-------------|
| `alb_dns_name` | ALB public DNS — point your domain's CNAME here |
| `database_endpoint` | RDS host:port |
| `database_url` | Full `postgresql://...` connection string *(sensitive)* |
| `redis_primary_endpoint` | ElastiCache primary hostname |
| `redis_url` | Full `redis://...` connection string |
| `ecs_cluster_name` | ECS cluster name |
| `ecs_service_name` | ECS service name |
| `vpc_id` | VPC ID |

## Environment Differences

| Feature | dev | staging | prod |
|---------|-----|---------|------|
| RDS Multi-AZ | ✗ | ✗ | ✓ |
| RDS deletion protection | ✗ | ✗ | ✓ |
| RDS backup retention | 1 day | 1 day | 14 days |
| Redis replicas | 1 (no failover) | 1 | 2 + Multi-AZ |
| ALB deletion protection | ✗ | ✗ | ✓ |

## Module Layout

```
terraform/
├── main.tf                    # Root module — provider, backend, module calls
├── variables.tf               # Root variables
├── outputs.tf                 # Root outputs
├── terraform.tfvars.example   # Safe placeholder values
└── modules/
    ├── networking/            # VPC, subnets, IGW, NAT, routes
    ├── database/              # RDS PostgreSQL 16
    ├── redis/                 # ElastiCache Redis 7
    └── web/                   # ECS Fargate, ALB, IAM, auto-scaling
```
