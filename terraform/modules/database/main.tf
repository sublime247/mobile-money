# ──────────────────────────────────────────────────────────────────────────────
# Database Module – RDS PostgreSQL 16
# Managed PostgreSQL instance matching the project's existing Postgres 16 usage.
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "main" {
  name       = "${var.project}-${var.environment}-db-subnet"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name        = "${var.project}-${var.environment}-db-subnet"
    Environment = var.environment
  }
}

resource "aws_db_parameter_group" "postgres" {
  name   = "${var.project}-${var.environment}-pg16-params"
  family = "postgres16"

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  tags = {
    Name        = "${var.project}-${var.environment}-pg-params"
    Environment = var.environment
  }
}

resource "aws_db_instance" "main" {
  identifier = "${var.project}-${var.environment}-postgres"

  # Engine
  engine               = "postgres"
  engine_version       = "16"
  instance_class       = var.db_instance_class
  parameter_group_name = aws_db_parameter_group.postgres.name

  # Storage
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  # Database
  db_name  = var.db_name
  username = var.db_username
  password = var.db_password
  port     = 5432

  # Network
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  # Backup & Maintenance
  backup_retention_period = var.db_backup_retention_days
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:30-sun:05:30"

  # Lifecycle
  skip_final_snapshot       = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${var.project}-${var.environment}-final-snapshot" : null
  deletion_protection       = var.environment == "production"

  tags = {
    Name        = "${var.project}-${var.environment}-postgres"
    Environment = var.environment
  }
}
