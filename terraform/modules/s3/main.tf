terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 5.0"
      configuration_aliases = [aws.replica]
    }
  }
}

resource "aws_kms_key" "primary" {
  description             = "${var.project}-${var.environment}-kyc-documents"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  multi_region            = true

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "kyc-documents"
  }
}

resource "aws_kms_alias" "primary" {
  name          = "alias/${var.project}-${var.environment}-kyc-documents"
  target_key_id = aws_kms_key.primary.key_id
}

resource "aws_kms_replica_key" "replica" {
  provider                = aws.replica
  description             = "${var.project}-${var.environment}-kyc-documents-replica"
  deletion_window_in_days = 30
  primary_key_arn         = aws_kms_key.primary.arn

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "kyc-documents-replica"
  }
}

resource "aws_kms_alias" "replica" {
  provider      = aws.replica
  name          = "alias/${var.project}-${var.environment}-kyc-documents-replica"
  target_key_id = aws_kms_replica_key.replica.key_id
}

resource "aws_s3_bucket" "replica" {
  provider = aws.replica
  bucket   = var.replica_bucket_name

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "kyc-documents-replica"
  }
}

resource "aws_s3_bucket_versioning" "replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.replica.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.replica.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_replica_key.replica.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket" "primary" {
  bucket = var.primary_bucket_name

  tags = {
    Project     = var.project
    Environment = var.environment
    Purpose     = "kyc-documents"
  }
}

resource "aws_s3_bucket_versioning" "primary" {
  bucket = aws_s3_bucket.primary.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "primary" {
  bucket = aws_s3_bucket.primary.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.primary.arn
    }
    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "replication_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "replication" {
  name               = "${var.project}-${var.environment}-kyc-s3-replication"
  assume_role_policy = data.aws_iam_policy_document.replication_assume_role.json
}

data "aws_iam_policy_document" "replication" {
  statement {
    actions   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
    resources = [aws_s3_bucket.primary.arn]
  }

  statement {
    actions   = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"]
    resources = ["${aws_s3_bucket.primary.arn}/*"]
  }

  statement {
    actions   = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]
    resources = ["${aws_s3_bucket.replica.arn}/*"]
  }

  statement {
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.primary.arn]
  }

  statement {
    actions   = ["kms:Encrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = [aws_kms_replica_key.replica.arn]
  }
}

resource "aws_iam_role_policy" "replication" {
  name   = "${var.project}-${var.environment}-kyc-s3-replication"
  role   = aws_iam_role.replication.id
  policy = data.aws_iam_policy_document.replication.json
}

resource "aws_s3_bucket_replication_configuration" "kyc_documents" {
  depends_on = [aws_s3_bucket_versioning.primary, aws_s3_bucket_versioning.replica]
  role       = aws_iam_role.replication.arn
  bucket     = aws_s3_bucket.primary.id

  rule {
    id     = "kyc-documents-crr"
    status = "Enabled"

    destination {
      bucket        = aws_s3_bucket.replica.arn
      storage_class = "STANDARD"

      encryption_configuration {
        replica_kms_key_id = aws_kms_replica_key.replica.arn
      }
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    delete_marker_replication {
      status = "Disabled"
    }
  }
}
