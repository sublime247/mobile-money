# Advanced Dispute Resolution Workflow

This document describes the enhanced dispute resolution system with evidence attachments, internal notes, automated SLA warnings, and state machine management.

## Overview

The advanced dispute resolution workflow provides:

- **Evidence Attachments**: Secure file uploads to S3 for dispute evidence
- **Internal Notes**: Private notes for support team collaboration
- **Automated SLA Warnings**: Priority-based SLA monitoring with automatic escalation
- **State Machine**: Enforced status transitions with validation
- **Timeline Tracking**: Complete audit trail of all dispute activities
- **Priority Management**: Four-tier priority system with automatic SLA calculation

## Dispute Status Flow

```
open ──→ investigating ──→ resolved
  │              │
  └──────────────┴──→ rejected
```

### Status Descriptions

- **open**: Initial state when dispute is created
- **investigating**: Dispute assigned to agent and under review
- **resolved**: Dispute resolved in favor of customer
- **rejected**: Dispute rejected after investigation

### Valid Transitions

| From          | To            | Requirements              |
| ------------- | ------------- | ------------------------- |
| open          | investigating | Must be assigned to agent |
| open          | resolved      | Resolution text required  |
| open          | rejected      | Resolution text required  |
| investigating | resolved      | Resolution text required  |
| investigating | rejected      | Resolution text required  |

## Priority System & SLA

### Priority Levels

| Priority | SLA Hours          | Use Case                           |
| -------- | ------------------ | ---------------------------------- |
| critical | 4 hours            | System outages, security issues    |
| high     | 24 hours           | Payment failures, account lockouts |
| medium   | 72 hours           | General transaction disputes       |
| low      | 168 hours (7 days) | Minor issues, feature requests     |

### SLA Monitoring

- **Warning Threshold**: 2 hours before SLA deadline
- **Automatic Escalation**: Priority increased for overdue disputes
- **Notifications**: Sent via configured notification system

## API Endpoints

### Core Dispute Management

#### Create Dispute

```http
POST /api/transactions/:id/dispute
Content-Type: application/json
Authorization: Bearer <token>

{
  "reason": "Transaction failed but amount was debited",
  "reportedBy": "user123",
  "priority": "high",
  "category": "payment_failure"
}
```

#### Get Dispute Details

```http
GET /api/disputes/:disputeId/details
Authorization: Bearer <token>
```

Returns dispute with notes, evidence, and timeline.

#### Update Dispute Status

```http
PATCH /api/disputes/:disputeId/status
Content-Type: application/json
Authorization: Bearer <token>

{
  "status": "resolved",
  "resolution": "Transaction was successfully reversed",
  "assignedTo": "agent@company.com"
}
```

#### Update Dispute Fields

```http
PATCH /api/disputes/:disputeId
Content-Type: application/json
Authorization: Bearer <token>

{
  "priority": "critical",
  "category": "fraud",
  "internalNotes": "Customer provided additional evidence"
}
```

### Evidence Management

#### Upload Single Evidence

```http
POST /api/disputes/:disputeId/evidence
Content-Type: multipart/form-data
Authorization: Bearer <token>

file: <binary_data>
description: "Bank statement showing duplicate charge"
```

#### Upload Multiple Evidence Files

```http
POST /api/disputes/:disputeId/evidence/multiple
Content-Type: multipart/form-data
Authorization: Bearer <token>

files[]: <binary_data>
files[]: <binary_data>
descriptions[]: "Receipt"
descriptions[]: "Email confirmation"
```

#### Get Evidence List

```http
GET /api/disputes/:disputeId/evidence
Authorization: Bearer <token>
```

### Notes Management

#### Add Note

```http
POST /api/disputes/:disputeId/notes
Content-Type: application/json
Authorization: Bearer <token>

{
  "author": "agent@company.com",
  "note": "Contacted payment processor for transaction details"
}
```

### Assignment

#### Assign to Agent

```http
POST /api/disputes/:disputeId/assign
Content-Type: application/json
Authorization: Bearer <token>

{
  "agentName": "senior.agent@company.com"
}
```

### Reporting & Monitoring

#### Generate Report

```http
GET /api/disputes/report?from=2024-01-01&to=2024-01-31&assignedTo=agent@company.com
Authorization: Bearer <token>
```

#### SLA Compliance Report

```http
GET /api/disputes/sla/report?days=30
Authorization: Bearer <token>
```

#### Get Overdue Disputes

```http
GET /api/disputes/overdue
Authorization: Bearer <token>
```

#### Trigger SLA Processing

```http
POST /api/disputes/sla/process
Authorization: Bearer <token>
```

## File Upload Specifications

### Supported File Types

- **Documents**: PDF, DOC, DOCX, XLS, XLSX, TXT
- **Images**: JPEG, JPG, PNG, GIF
- **Maximum Size**: 10MB per file
- **Maximum Files**: 5 files per upload

### S3 Storage Structure

```
dispute-evidence/
├── 2024/
│   ├── 01/
│   │   ├── dispute-uuid-1/
│   │   │   ├── receipt-1704067200-abc123.pdf
│   │   │   └── statement-1704067300-def456.jpg
│   │   └── dispute-uuid-2/
│   └── 02/
└── 2025/
```

## Database Schema

### New Tables

#### dispute_evidence

```sql
CREATE TABLE dispute_evidence (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id      UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  file_name       VARCHAR(255) NOT NULL,
  file_type       VARCHAR(50) NOT NULL,
  file_size       INTEGER NOT NULL,
  s3_key          VARCHAR(500) NOT NULL,
  s3_url          VARCHAR(500) NOT NULL,
  uploaded_by     VARCHAR(100) NOT NULL,
  description     TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

#### dispute_timeline

```sql
CREATE TABLE dispute_timeline (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id      UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  event_type      VARCHAR(50) NOT NULL,
  old_status      VARCHAR(20),
  new_status      VARCHAR(20),
  actor           VARCHAR(100) NOT NULL,
  description     TEXT,
  metadata        JSONB,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Enhanced disputes Table

New columns added:

- `sla_due_date`: Calculated SLA deadline
- `sla_warning_sent`: Flag for warning notification
- `priority`: Priority level (low/medium/high/critical)
- `category`: Dispute category for classification
- `internal_notes`: Private notes for support team

## Permissions

### Required Permissions

- `dispute:create` - Create new disputes
- `dispute:read` - View dispute details
- `dispute:update` - Update dispute fields and add notes
- `dispute:assign` - Assign disputes to agents
- `dispute:manage` - Administrative functions (SLA processing)

### Role-Based Access

- **Customer**: Can create disputes and view their own
- **Agent**: Can view, update, and resolve assigned disputes
- **Supervisor**: Can view all disputes and reassign
- **Admin**: Full access including SLA management

## Automated Jobs

### Dispute SLA Job

**Schedule**: Every hour (`0 * * * *`)

**Functions**:

- Send SLA warning notifications
- Escalate overdue disputes
- Update priority levels
- Generate compliance metrics

**Configuration**:

```env
DISPUTE_SLA_CRON=0 * * * *  # Every hour
```

## Notifications

### Event Types

- `dispute.opened` - New dispute created
- `dispute.assigned` - Dispute assigned to agent
- `dispute.status_changed` - Status transition
- `dispute.evidence_added` - Evidence uploaded
- `dispute.sla_warning` - SLA deadline approaching
- `dispute.escalated` - Dispute escalated due to SLA breach

### Notification Payload

```json
{
  "event": "dispute.sla_warning",
  "disputeId": "uuid",
  "transactionId": "uuid",
  "status": "investigating",
  "message": "Dispute approaching SLA deadline",
  "metadata": {
    "slaDueDate": "2024-01-15T14:00:00Z",
    "priority": "high",
    "assignedTo": "agent@company.com"
  }
}
```

## Configuration

### Environment Variables

```env
# S3 Configuration
AWS_REGION=us-east-1
AWS_S3_BUCKET=dispute-evidence-bucket
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key

# SLA Job Schedule
DISPUTE_SLA_CRON=0 * * * *

# File Upload Limits
MAX_EVIDENCE_FILE_SIZE=10485760  # 10MB
MAX_EVIDENCE_FILES=5
```

## Security Considerations

### File Upload Security

- File type validation using MIME type checking
- File size limits to prevent DoS attacks
- Unique filename generation to prevent conflicts
- Private S3 bucket with restricted access
- Virus scanning (recommended for production)

### Access Control

- JWT-based authentication required
- RBAC permissions for all operations
- Audit trail for all dispute activities
- Secure file URLs with expiration (recommended)

## Monitoring & Metrics

### Key Metrics

- **SLA Compliance Rate**: Percentage of disputes resolved within SLA
- **Average Resolution Time**: Mean time from creation to resolution
- **Escalation Rate**: Percentage of disputes requiring escalation
- **Evidence Upload Success Rate**: File upload reliability

### Dashboards

Recommended Grafana dashboard panels:

- Dispute volume by priority
- SLA compliance trends
- Agent workload distribution
- Resolution time by category

## Troubleshooting

### Common Issues

#### File Upload Failures

- Check S3 credentials and bucket permissions
- Verify file size and type restrictions
- Monitor S3 service availability

#### SLA Job Not Running

- Verify cron schedule configuration
- Check job scheduler logs
- Ensure database connectivity

#### State Transition Errors

- Review state machine validation rules
- Check required fields for transitions
- Verify user permissions

### Logs

Key log patterns to monitor:

```
[DisputeSlaJob] Starting SLA monitoring job...
[DisputeNotification] dispute.sla_warning sent for dispute-uuid
S3 dispute evidence upload error: <error-details>
```

## Migration Guide

### Database Migration

Run the migration script:

```bash
psql -d mobile_money -f database/migrations/add_dispute_evidence_and_sla.sql
```

### Code Deployment

1. Deploy new dispute model and service files
2. Update route handlers with new endpoints
3. Configure S3 bucket and permissions
4. Update scheduler with SLA job
5. Test file upload functionality
6. Verify SLA monitoring

### Testing

```bash
# Run dispute-related tests
npm test -- --grep "dispute"

# Test file upload endpoints
curl -X POST -F "file=@test.pdf" \
  -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/disputes/uuid/evidence

# Test SLA job manually
curl -X POST -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/disputes/sla/process
```

This completes the advanced dispute resolution workflow implementation with evidence attachments, internal notes, automated SLA warnings, and state machine management.
