# KYC Document Upload Documentation

## Overview

This document describes the KYC document upload feature that allows users to securely upload identity verification documents to AWS S3 storage.

## Features

- **Secure File Upload**: Documents are uploaded directly to AWS S3 with encryption
- **File Validation**: Automatic validation of file types and sizes
- **Unique Filenames**: Generated with timestamps and random hashes to prevent collisions
- **Organized Storage**: Files are organized by year/month/user in S3
- **Database Tracking**: All uploads are tracked in the database with metadata
- **Access Control**: Users can only upload documents for their own KYC applications

## Supported File Types

The following file types are accepted for KYC document uploads:

- **PDF**: `application/pdf`
- **JPEG**: `image/jpeg`, `image/jpg`
- **PNG**: `image/png`

## File Size Limits

- **Maximum file size**: 5MB per document
- Files exceeding this limit will be rejected with an error message

## API Endpoints

### Upload Document

Upload a KYC document to S3 storage.

**Endpoint**: `POST /api/kyc/documents/upload`

**Authentication**: Required (JWT Bearer token)

**Content-Type**: `multipart/form-data`

**Form Fields**:

- `document` (file, required): The document file to upload
- `applicant_id` (string, required): The KYC applicant ID
- `document_type` (string, optional): Type of document (e.g., "passport", "driving_license", "national_identity_card", "residence_permit")
- `document_side` (string, optional): Side of document ("front" or "back")

**Example Request (cURL)**:

```bash
curl -X POST http://localhost:3000/api/kyc/documents/upload \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -F "document=@/path/to/passport.pdf" \
  -F "applicant_id=abc123" \
  -F "document_type=passport" \
  -F "document_side=front"
```

**Example Request (JavaScript/Fetch)**:

```javascript
const formData = new FormData();
formData.append("document", fileInput.files[0]);
formData.append("applicant_id", "abc123");
formData.append("document_type", "passport");
formData.append("document_side", "front");

const response = await fetch("http://localhost:3000/api/kyc/documents/upload", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
  },
  body: formData,
});

const result = await response.json();
```

**Success Response (201 Created)**:

```json
{
  "success": true,
  "data": {
    "document_id": "550e8400-e29b-41d4-a716-446655440000",
    "file_url": "https://mobile-money-kyc-documents.s3.us-east-1.amazonaws.com/kyc-documents/2024/03/user-id/passport-1234567890-abc123def456.pdf",
    "applicant_id": "abc123",
    "uploaded_at": "2024-03-26T10:30:00.000Z"
  }
}
```

**Error Responses**:

**400 Bad Request** - No file uploaded:

```json
{
  "error": "No file uploaded"
}
```

**400 Bad Request** - Invalid file type:

```json
{
  "error": "Invalid file type. Allowed types: application/pdf, image/jpeg, image/png"
}
```

**400 Bad Request** - File too large:

```json
{
  "error": "File size exceeds maximum limit of 5MB"
}
```

**401 Unauthorized** - Missing or invalid token:

```json
{
  "error": "User not authenticated"
}
```

**403 Forbidden** - User doesn't own the applicant:

```json
{
  "error": "Access denied"
}
```

**500 Internal Server Error** - Upload failed:

```json
{
  "error": "File upload failed",
  "details": "Error message details"
}
```

### Get User Documents

Retrieve all documents uploaded by the authenticated user.

**Endpoint**: `GET /api/kyc/documents`

**Authentication**: Required (JWT Bearer token)

**Example Request**:

```bash
curl -X GET http://localhost:3000/api/kyc/documents \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Success Response (200 OK)**:

```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "applicant_id": "abc123",
      "document_type": "passport",
      "document_side": "front",
      "file_url": "https://mobile-money-kyc-documents.s3.us-east-1.amazonaws.com/kyc-documents/2024/03/user-id/passport-1234567890-abc123def456.pdf",
      "original_filename": "passport.pdf",
      "file_size": 1048576,
      "mime_type": "application/pdf",
      "created_at": "2024-03-26T10:30:00.000Z"
    }
  ]
}
```

## AWS S3 Configuration

### Environment Variables

Add the following variables to your `.env` file:

```env
# AWS S3 Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
AWS_S3_BUCKET=mobile-money-kyc-documents
```

### S3 Bucket Setup

1. **Create S3 Bucket**:
   - Log in to AWS Console
   - Navigate to S3
   - Click "Create bucket"
   - Enter bucket name (e.g., `mobile-money-kyc-documents`)
   - Select region (e.g., `us-east-1`)
   - Keep "Block all public access" enabled for security

2. **Configure Bucket Permissions**:
   - Create an IAM user for the application
   - Attach a policy with the following permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::mobile-money-kyc-documents/*",
        "arn:aws:s3:::mobile-money-kyc-documents"
      ]
    }
  ]
}
```

3. **Enable Encryption** (Recommended):
   - Go to bucket properties
   - Enable "Default encryption"
   - Choose "Amazon S3 managed keys (SSE-S3)" or "AWS KMS"

4. **Configure Lifecycle Rules** (Optional):
   - Set up automatic deletion of old documents after a retention period
   - Example: Delete documents older than 7 years

### S3 Object Structure

Documents are organized in S3 with the following structure:

```
kyc-documents/
  └── {year}/
      └── {month}/
          └── {user_id}/
              └── {filename}-{timestamp}-{random_hash}.{ext}
```

Example:

```
kyc-documents/2024/03/550e8400-e29b-41d4-a716-446655440000/passport-1711449000000-abc123def456.pdf
```

## Database Schema

### kyc_documents Table

```sql
CREATE TABLE kyc_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  applicant_id VARCHAR(255) NOT NULL,
  document_type VARCHAR(50) NOT NULL,
  document_side VARCHAR(10),
  file_url TEXT NOT NULL,
  s3_key TEXT NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type VARCHAR(50) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Columns**:

- `id`: Unique document identifier
- `user_id`: Reference to the user who uploaded the document
- `applicant_id`: KYC applicant ID from the verification provider
- `document_type`: Type of document (passport, license, etc.)
- `document_side`: Side of document (front/back)
- `file_url`: Public URL to access the file in S3
- `s3_key`: S3 object key for internal operations
- `original_filename`: Original filename from upload
- `file_size`: File size in bytes
- `mime_type`: MIME type of the file
- `created_at`: Upload timestamp
- `updated_at`: Last update timestamp

## Security Features

### File Validation

1. **MIME Type Validation**: Only allowed file types can be uploaded
2. **File Size Validation**: Files exceeding 5MB are rejected
3. **Filename Sanitization**: Special characters are removed from filenames

### Access Control

1. **Authentication Required**: All endpoints require valid JWT token
2. **User Ownership**: Users can only upload documents for their own KYC applications
3. **Private S3 Bucket**: Documents are stored in a private bucket (not publicly accessible)

### Storage Security

1. **Unique Filenames**: Prevents filename collisions and guessing
2. **Organized Structure**: Files are organized by date and user
3. **Encryption**: S3 server-side encryption can be enabled
4. **Metadata**: Upload metadata is stored for audit trails

## Optional: Virus Scanning

For production environments, consider implementing virus scanning:

### Option 1: AWS Lambda with ClamAV

1. Create Lambda function with ClamAV
2. Trigger on S3 upload events
3. Scan files and quarantine infected ones

### Option 2: Third-Party Service

Integrate with services like:

- **VirusTotal API**: Scan files using multiple antivirus engines
- **MetaDefender**: Cloud-based malware scanning
- **Cloudmersive**: Virus scanning API

### Implementation Example

```typescript
import axios from "axios";

export const scanFileForVirus = async (
  fileBuffer: Buffer,
): Promise<boolean> => {
  try {
    const response = await axios.post(
      "https://virus-scan-api.com/scan",
      {
        file: fileBuffer.toString("base64"),
      },
      {
        headers: {
          "X-API-Key": process.env.VIRUS_SCAN_API_KEY,
        },
      },
    );

    return response.data.clean === true;
  } catch (error) {
    console.error("Virus scan error:", error);
    // Fail closed: reject file if scan fails
    return false;
  }
};
```

## Testing

### Manual Testing

1. **Test valid upload**:

```bash
curl -X POST http://localhost:3000/api/kyc/documents/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "document=@test.pdf" \
  -F "applicant_id=test123" \
  -F "document_type=passport"
```

2. **Test invalid file type**:

```bash
curl -X POST http://localhost:3000/api/kyc/documents/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "document=@test.txt" \
  -F "applicant_id=test123"
```

3. **Test file too large**:

```bash
# Create a 6MB file
dd if=/dev/zero of=large.pdf bs=1M count=6

curl -X POST http://localhost:3000/api/kyc/documents/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "document=@large.pdf" \
  -F "applicant_id=test123"
```

### Automated Testing

Create tests in `src/routes/__tests__/kycRoutes.test.ts`:

```typescript
import request from "supertest";
import app from "../../index";

describe("KYC Document Upload", () => {
  it("should upload a valid PDF document", async () => {
    const response = await request(app)
      .post("/api/kyc/documents/upload")
      .set("Authorization", `Bearer ${validToken}`)
      .attach("document", "test/fixtures/passport.pdf")
      .field("applicant_id", "test123")
      .field("document_type", "passport");

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.file_url).toBeDefined();
  });

  it("should reject invalid file type", async () => {
    const response = await request(app)
      .post("/api/kyc/documents/upload")
      .set("Authorization", `Bearer ${validToken}`)
      .attach("document", "test/fixtures/test.txt")
      .field("applicant_id", "test123");

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid file type");
  });
});
```

## Troubleshooting

### Common Issues

1. **"AWS credentials not configured"**
   - Ensure `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set in `.env`
   - Verify credentials are valid

2. **"S3 bucket not configured"**
   - Set `AWS_S3_BUCKET` in `.env`
   - Verify bucket exists in AWS

3. **"Access Denied" from S3**
   - Check IAM user permissions
   - Verify bucket policy allows PutObject

4. **"File too large" error**
   - Check file size is under 5MB
   - Adjust `MAX_FILE_SIZE` in `upload.ts` if needed

5. **"Invalid file type" error**
   - Verify file MIME type is in allowed list
   - Check file extension matches content

## Best Practices

1. **Use Environment-Specific Buckets**: Separate buckets for dev/staging/production
2. **Enable Versioning**: Keep previous versions of documents
3. **Set Up Monitoring**: CloudWatch alerts for failed uploads
4. **Implement Logging**: Log all upload attempts for audit
5. **Regular Backups**: Enable S3 cross-region replication
6. **Access Logs**: Enable S3 access logging for security audits
7. **Cost Optimization**: Use S3 Intelligent-Tiering for cost savings

## Compliance Considerations

- **Data Retention**: Implement policies for document retention periods
- **GDPR**: Ensure ability to delete user documents on request
- **Encryption**: Use encryption at rest and in transit
- **Audit Trail**: Maintain logs of all document access
- **Access Control**: Implement least-privilege access policies

## Future Enhancements

- [ ] Add support for document deletion
- [ ] Implement document expiration
- [ ] Add OCR for automatic data extraction
- [ ] Support for document verification status
- [ ] Integration with document verification APIs
- [ ] Support for multiple file uploads
- [ ] Add image compression for photos
- [ ] Implement document preview generation
