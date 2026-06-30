# AWS S3 Setup Guide for KYC Document Upload

This guide walks you through setting up AWS S3 for KYC document storage.

## Prerequisites

- AWS Account
- AWS CLI installed (optional but recommended)
- Access to create IAM users and S3 buckets

## Step 1: Create S3 Bucket

### Using AWS Console

1. Log in to [AWS Console](https://console.aws.amazon.com/)
2. Navigate to **S3** service
3. Click **Create bucket**
4. Configure bucket:
   - **Bucket name**: `mobile-money-kyc-documents` (must be globally unique)
   - **AWS Region**: Choose your preferred region (e.g., `us-east-1`)
   - **Block Public Access**: Keep all options checked (recommended for security)
   - **Bucket Versioning**: Enable (recommended for document history)
   - **Default encryption**: Enable with SSE-S3 or AWS KMS
5. Click **Create bucket**

### Using AWS CLI

```bash
# Create bucket
aws s3 mb s3://mobile-money-kyc-documents --region us-east-1

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket mobile-money-kyc-documents \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
  --bucket mobile-money-kyc-documents \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'
```

## Step 2: Create IAM User

### Using AWS Console

1. Navigate to **IAM** service
2. Click **Users** → **Add users**
3. Configure user:
   - **User name**: `mobile-money-s3-uploader`
   - **Access type**: Select "Programmatic access"
4. Click **Next: Permissions**
5. Click **Attach policies directly**
6. Click **Create policy** (opens new tab)

### Create Custom Policy

In the new tab:

1. Click **JSON** tab
2. Paste the following policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "KYCDocumentUpload",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:GetObject",
        "s3:GetObjectAcl",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::mobile-money-kyc-documents",
        "arn:aws:s3:::mobile-money-kyc-documents/*"
      ]
    }
  ]
}
```

3. Click **Next: Tags** (optional)
4. Click **Next: Review**
5. **Policy name**: `MobileMoneyKYCUploadPolicy`
6. Click **Create policy**

### Attach Policy to User

1. Return to the user creation tab
2. Refresh the policy list
3. Search for `MobileMoneyKYCUploadPolicy`
4. Check the policy
5. Click **Next: Tags** (optional)
6. Click **Next: Review**
7. Click **Create user**
8. **IMPORTANT**: Save the **Access Key ID** and **Secret Access Key** (you won't see them again)

### Using AWS CLI

```bash
# Create IAM user
aws iam create-user --user-name mobile-money-s3-uploader

# Create policy
cat > kyc-upload-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "KYCDocumentUpload",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:GetObject",
        "s3:GetObjectAcl",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::mobile-money-kyc-documents",
        "arn:aws:s3:::mobile-money-kyc-documents/*"
      ]
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name MobileMoneyKYCUploadPolicy \
  --policy-document file://kyc-upload-policy.json

# Attach policy to user (replace ACCOUNT_ID with your AWS account ID)
aws iam attach-user-policy \
  --user-name mobile-money-s3-uploader \
  --policy-arn arn:aws:iam::ACCOUNT_ID:policy/MobileMoneyKYCUploadPolicy

# Create access key
aws iam create-access-key --user-name mobile-money-s3-uploader
```

## Step 3: Configure Application

Add the following to your `.env` file:

```env
# AWS S3 Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_S3_BUCKET=mobile-money-kyc-documents
```

Replace the values with your actual credentials from Step 2.

## Step 4: Test Configuration

### Test S3 Connection

Create a test script `test-s3.ts`:

```typescript
import { getS3Client } from "./src/config/s3";
import { ListBucketsCommand } from "@aws-sdk/client-s3";

async function testS3Connection() {
  try {
    const client = getS3Client();
    const command = new ListBucketsCommand({});
    const response = await client.send(command);

    console.log("✓ S3 connection successful!");
    console.log(
      "Buckets:",
      response.Buckets?.map((b) => b.Name),
    );
  } catch (error) {
    console.error("✗ S3 connection failed:", error);
  }
}

testS3Connection();
```

Run the test:

```bash
npx tsx test-s3.ts
```

### Test File Upload

```bash
# Create a test file
echo "Test document" > test.pdf

# Upload using curl
curl -X POST http://localhost:3000/api/kyc/documents/upload \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "document=@test.pdf" \
  -F "applicant_id=test123" \
  -F "document_type=test"
```

## Step 5: Security Best Practices

### Enable Bucket Logging

Track all access to your bucket:

```bash
# Create logging bucket
aws s3 mb s3://mobile-money-kyc-logs

# Enable logging
aws s3api put-bucket-logging \
  --bucket mobile-money-kyc-documents \
  --bucket-logging-status '{
    "LoggingEnabled": {
      "TargetBucket": "mobile-money-kyc-logs",
      "TargetPrefix": "kyc-access-logs/"
    }
  }'
```

### Enable CloudTrail

Monitor API calls to S3:

1. Navigate to **CloudTrail** in AWS Console
2. Create a new trail
3. Enable S3 data events for your bucket

### Set Up Lifecycle Rules

Automatically manage old documents:

```bash
cat > lifecycle-policy.json << EOF
{
  "Rules": [
    {
      "Id": "ArchiveOldDocuments",
      "Status": "Enabled",
      "Transitions": [
        {
          "Days": 90,
          "StorageClass": "STANDARD_IA"
        },
        {
          "Days": 365,
          "StorageClass": "GLACIER"
        }
      ],
      "Expiration": {
        "Days": 2555
      }
    }
  ]
}
EOF

aws s3api put-bucket-lifecycle-configuration \
  --bucket mobile-money-kyc-documents \
  --lifecycle-configuration file://lifecycle-policy.json
```

### Enable MFA Delete (Optional)

Require MFA for deleting objects:

```bash
aws s3api put-bucket-versioning \
  --bucket mobile-money-kyc-documents \
  --versioning-configuration Status=Enabled,MFADelete=Enabled \
  --mfa "arn:aws:iam::ACCOUNT_ID:mfa/USER TOKENCODE"
```

## Step 6: Monitoring and Alerts

### CloudWatch Alarms

Set up alerts for unusual activity:

```bash
# Alert on high number of 4xx errors
aws cloudwatch put-metric-alarm \
  --alarm-name kyc-s3-4xx-errors \
  --alarm-description "Alert on S3 4xx errors" \
  --metric-name 4xxErrors \
  --namespace AWS/S3 \
  --statistic Sum \
  --period 300 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1
```

### Cost Monitoring

1. Navigate to **AWS Budgets**
2. Create a budget for S3 costs
3. Set alerts for cost thresholds

## Troubleshooting

### Error: "Access Denied"

**Cause**: IAM user doesn't have required permissions

**Solution**:

1. Verify IAM policy is attached to user
2. Check bucket policy doesn't block access
3. Ensure credentials in `.env` are correct

### Error: "Bucket does not exist"

**Cause**: Bucket name is incorrect or in different region

**Solution**:

1. Verify bucket name in `.env` matches actual bucket
2. Check `AWS_REGION` matches bucket region

### Error: "Credentials not configured"

**Cause**: Environment variables not loaded

**Solution**:

1. Ensure `.env` file exists
2. Restart application after updating `.env`
3. Check `dotenv.config()` is called before S3 client creation

### Error: "SignatureDoesNotMatch"

**Cause**: Incorrect secret access key or clock skew

**Solution**:

1. Verify `AWS_SECRET_ACCESS_KEY` is correct
2. Check system clock is synchronized
3. Regenerate access keys if needed

## Production Checklist

- [ ] Bucket has versioning enabled
- [ ] Bucket has encryption enabled
- [ ] Block public access is enabled
- [ ] IAM user has minimal required permissions
- [ ] Access logging is enabled
- [ ] CloudTrail is monitoring S3 events
- [ ] Lifecycle rules are configured
- [ ] CloudWatch alarms are set up
- [ ] Cost budgets are configured
- [ ] Credentials are stored securely (not in code)
- [ ] Different buckets for dev/staging/production
- [ ] Backup/replication is configured
- [ ] CORS is configured if needed for direct browser uploads

## Alternative: Using LocalStack for Development

For local development without AWS costs:

```bash
# Install LocalStack
pip install localstack

# Start LocalStack
localstack start

# Configure application to use LocalStack
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_S3_BUCKET=mobile-money-kyc-documents
AWS_ENDPOINT_URL=http://localhost:4566
```

Update `src/config/s3.ts` to support LocalStack:

```typescript
export const createS3Client = (): S3Client => {
  const config: any = {
    region: s3Config.region,
    credentials: {
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
    },
  };

  // Use LocalStack for development
  if (process.env.AWS_ENDPOINT_URL) {
    config.endpoint = process.env.AWS_ENDPOINT_URL;
    config.forcePathStyle = true;
  }

  return new S3Client(config);
};
```

## Resources

- [AWS S3 Documentation](https://docs.aws.amazon.com/s3/)
- [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [S3 Security Best Practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)
