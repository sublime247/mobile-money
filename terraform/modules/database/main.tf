######################################################################
# mobile-money — Database Module (RDS PostgreSQL 16)
# Resources: DB subnet group, security group, RDS instance
######################################################################

locals {
  name_prefix = "${var.app_name}-${var.environment}"
}

# ---------------------------------------------------------------------------
# DB Subnet Group — uses private subnets
# ---------------------------------------------------------------------------
resource "aws_db_subnet_group" "main" {
  name        = "${local.name_prefix}-db-subnet-group"
  subnet_ids  = var.private_subnet_ids
  description = "Subnet group for ${local.name_prefix} RDS instance"

  tags = {
    Name = "${local.name_prefix}-db-subnet-group"
  }
}

# ---------------------------------------------------------------------------
# Security Group — RDS
# Only accept connections on port 5432 from the app security group
# ---------------------------------------------------------------------------
resource "aws_security_group" "rds" {
  name        = "${local.name_prefix}-rds-sg"
  description = "Security group for ${local.name_prefix} RDS PostgreSQL"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL from app tier"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-rds-sg"
  }
}

# ---------------------------------------------------------------------------
# Parameter Group — postgres 16
# ---------------------------------------------------------------------------
resource "aws_db_parameter_group" "main" {
  name        = "${local.name_prefix}-pg16"
  family      = "postgres16"
  description = "Custom parameter group for ${local.name_prefix}"

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # log queries slower than 1 s
  }

  tags = {
    Name = "${local.name_prefix}-pg16"
  }
}

# ---------------------------------------------------------------------------
# RDS Instance — PostgreSQL 16, Multi-AZ, encrypted
# ---------------------------------------------------------------------------
resource "aws_db_instance" "main" {
  identifier        = "${local.name_prefix}-postgres"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = var.db_instance_class
  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.db_name
  username = var.db_username
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  multi_az              = var.environment == "prod" ? true : false
  publicly_accessible   = false
  skip_final_snapshot   = var.environment != "prod"
  deletion_protection   = var.environment == "prod"
  copy_tags_to_snapshot = true

  backup_retention_period = var.environment == "prod" ? 14 : 1
  backup_window           = "03:00-04:00"
  maintenance_window      = "mon:04:00-mon:05:00"

  # Enable Performance Insights (free tier: 7 days retention)
  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  tags = {
    Name = "${local.name_prefix}-postgres"
  }
}
