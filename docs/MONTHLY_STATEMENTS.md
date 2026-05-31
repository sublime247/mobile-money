# Monthly Account Statements PDF Generator

This feature allows users to download professionally formatted PDF statements of their monthly transaction activities.

## Overview

The Monthly Account Statements feature provides:

- Chronologically ordered transaction history
- Standard accounting header and footer
- Professional PDF formatting
- Balance calculations and summaries
- Secure user authentication

## API Endpoint

### Generate Monthly Statement

```
GET /api/statements/monthly/:year/:month
```

**Authentication**: Required (JWT Bearer token)

**Parameters**:

- `year` (path): 4-digit year (e.g., 2024)
- `month` (path): Month number 1-12 (e.g., 1 for January)

**Response**:

- Content-Type: `application/pdf`
- Content-Disposition: `attachment; filename="statement-YYYY-MM.pdf"`
- Binary PDF data

**Status Codes**:

- `200`: Success - PDF generated and returned
- `400`: Invalid year or month parameters
- `401`: User not authenticated
- `404`: No data found for the specified period
- `500`: Server error during PDF generation

## Statement Contents

### Header Section

- Company name and branding
- Statement period (Month Year)
- Account information (phone number, KYC level)
- Generation timestamp

### Account Summary

- Opening balance (from previous periods)
- Total deposits for the month
- Total withdrawals for the month
- Closing balance (calculated)
- Transaction count

### Transaction Details Table

- Date of transaction
- Reference number
- Transaction type (Deposit/Withdrawal)
- Provider name
- Amount (formatted as currency)
- Notes (if available)

### Footer Section

- Legal disclaimer
- Contact information
- Page numbering

## Usage Examples

### JavaScript/Node.js

```javascript
import axios from "axios";
import fs from "fs";

async function downloadStatement(authToken, year, month) {
  const response = await axios.get(
    `http://localhost:3000/api/statements/monthly/${year}/${month}`,
    {
      headers: { Authorization: `Bearer ${authToken}` },
      responseType: "arraybuffer",
    },
  );

  fs.writeFileSync(`statement-${year}-${month}.pdf`, response.data);
}
```

### cURL

```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -o statement-2024-01.pdf \
     http://localhost:3000/api/statements/monthly/2024/1
```

### Frontend (React/JavaScript)

```javascript
async function downloadStatement(year, month) {
  const token = localStorage.getItem("authToken");

  const response = await fetch(`/api/statements/monthly/${year}/${month}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.ok) {
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `statement-${year}-${month}.pdf`;
    a.click();
  }
}
```

## Security Features

- **Authentication Required**: All requests must include valid JWT token
- **User Isolation**: Users can only access their own statements
- **Data Encryption**: Sensitive data (phone numbers, notes) are decrypted only for authorized users
- **Input Validation**: Year and month parameters are strictly validated

## Performance Considerations

- **Database Optimization**: Queries use indexes on user_id and created_at
- **Memory Efficient**: PDF generation streams directly to client
- **Connection Pooling**: Uses PostgreSQL connection pool for database access
- **Timeout Protection**: Medium timeout preset applied to prevent hanging requests

## Error Handling

The API provides detailed error responses:

```json
{
  "error": "Invalid year or month"
}
```

```json
{
  "error": "No data found for the specified period"
}
```

```json
{
  "error": "User not authenticated"
}
```

## Dependencies

- **jsPDF**: PDF generation library
- **jspdf-autotable**: Table formatting for transaction details
- **PostgreSQL**: Database queries for transaction data
- **JWT**: User authentication

## Installation

1. Install required dependencies:

```bash
npm install jspdf jspdf-autotable
npm install --save-dev @types/jspdf
```

2. The route is automatically registered in the main application at `/api/statements`

## Testing

Run the test suite:

```bash
npm test -- statements.test.ts
```

The tests cover:

- Authentication requirements
- Parameter validation
- PDF generation with mock data
- Error handling scenarios

## Compliance Notes

- Statements include legal disclaimers
- Generated electronically without requiring signatures
- Professional formatting meets accounting standards
- Amounts balance logically (opening + deposits - withdrawals = closing)

## Future Enhancements

Potential improvements:

- Multi-currency support in statements
- Custom date range selection
- Email delivery of statements
- Statement archival and retrieval
- Digital signatures for enhanced security
