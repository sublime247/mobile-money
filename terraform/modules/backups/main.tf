/**
 * S3 Backup Bucket Configuration (Issue #553)
 * 
 * Implements:
 * - Encrypted backup storage
 * - 30-day retention with automatic cleanup
 * - Versioning for integrity
 * - Access logging for audit trail
 * - Lifecycle policies for cost optimization
 */

resource "aws_s3_bucket" "backups" {
  bucket = "${var.project}-${var.environment}-backups"

  tags = {
    Name        = "${var.project}-${var.environment}-backups"
    Environment = var.environment
    Purpose     = "database-backups"
  }
}

# ── Block public access ────────────────────────────────────────────────────

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── Versioning (for integrity verification) ────────────────────────────────

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

# ── Server-side encryption ─────────────────────────────────────────────────

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ── Access Logging (audit trail) ───────────────────────────────────────────

resource "aws_s3_bucket" "backup_logs" {
  bucket = "${var.project}-${var.environment}-backup-logs"

  tags = {
    Name        = "${var.project}-${var.environment}-backup-logs"
    Environment = var.environment
    Purpose     = "access-logs"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup_logs" {
  bucket = aws_s3_bucket.backup_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_logging" "backups" {
  bucket = aws_s3_bucket.backups.id

  target_bucket = aws_s3_bucket.backup_logs.id
  target_prefix = "backups/"
}

# ── Lifecycle Policy (30-day retention, then delete) ────────────────────────

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "delete-old-backups"
    status = "Enabled"

    # Delete backups older than 30 days
    expiration {
      days = var.backup_retention_days
    }

    # Delete old versions of backups after 7 days (keep current + 1 previous)
    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    # Transition to GLACIER after 7 days for long-term storage (optional)
    # Uncomment if you want archival after retention period starts
    # transition {
    #   days          = 7
    #   storage_class = "GLACIER"
    # }

    # Apply to all backup objects
    filter {
      prefix = "backups/"
    }
  }

  # Clean up old log files
  rule {
    id     = "delete-old-logs"
    status = "Enabled"

    expiration {
      days = 90
    }

    filter {
      prefix = "backups/"
    }
  }
}

# ── Backup bucket policy (allow backup service to upload) ──────────────────

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.backups.arn,
          "${aws_s3_bucket.backups.arn}/*"
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
      {
        Sid    = "AllowBackupServiceAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.ecs_task_role_name}"
        }
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.backups.arn,
          "${aws_s3_bucket.backups.arn}/*"
        ]
      }
    ]
  })
}

# ── CloudWatch Alarms ──────────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "backup_bucket_size" {
  alarm_name          = "${var.project}-${var.environment}-backup-bucket-size"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "1"
  metric_name         = "BucketSizeBytes"
  namespace           = "AWS/S3"
  period              = "86400" # Daily
  statistic           = "Average"
  threshold           = 100 * 1024 * 1024 * 1024 # 100 GB alert threshold
  alarm_description   = "Alert when backup bucket size exceeds 100 GB"
  treat_missing_data  = "notBreaching"

  dimensions = {
    BucketName  = aws_s3_bucket.backups.id
    StorageType = "StandardStorage"
  }

  alarm_actions = [var.alarm_topic_arn]
}

# ── Outputs ────────────────────────────────────────────────────────────────

output "backup_bucket_name" {
  description = "Name of the S3 backup bucket"
  value       = aws_s3_bucket.backups.id
}

output "backup_bucket_arn" {
  description = "ARN of the S3 backup bucket"
  value       = aws_s3_bucket.backups.arn
}

output "backup_logs_bucket_name" {
  description = "Name of the S3 access logs bucket"
  value       = aws_s3_bucket.backup_logs.id
}

output "retention_days" {
  description = "Backup retention period in days"
  value       = var.backup_retention_days
}
