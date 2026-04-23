# SEP-31 Cross-Border Payments Implementation

## Overview

This implementation provides full SEP-31 (Cross-Border Payments) protocol support for the Stellar network, enabling anchors to facilitate payments between different currencies/assets.

## Features Implemented

### ✅ Core SEP-31 Endpoints
- **GET /info**: Returns supported assets, fees, and required fields
- **POST /transactions**: Creates new cross-border payment transactions
- **GET /transactions/:id**: Retrieves transaction status and details
- **PATCH /transactions/:id**: Updates transaction fields (e.g., additional info requests)

### ✅ Transaction Lifecycle Management
- **Status State Machine**: Proper SEP-31 status transitions (pending_sender → pending_stellar → pending_receiver → completed)
- **Metadata Persistence**: All SEP-31 data correctly stored in transaction metadata
- **Payment Monitoring**: Automated job monitors for incoming Stellar payments
- **Status Updates**: Automatic status progression based on payment receipt

### ✅ Compliance & Validation
- **SEP-12 Integration**: Sender/receiver identification via SEP-12
- **Fee Calculation**: Configurable fixed and percentage fees
- **Amount Limits**: Configurable min/max transaction amounts
- **Asset Support**: Support for native XLM and custom assets
- **Memo Handling**: Unique memo generation for payment identification

## Configuration

### Environment Variables

```bash
# SEP-31 Configuration
SEP31_MIN_AMOUNT=0.1
SEP31_MAX_AMOUNT=1000000
SEP31_FEE_FIXED=1.00
SEP31_FEE_PERCENT=0.5
SEP31_STATUS_ETA=600
STELLAR_RECEIVING_ACCOUNT=G...

# SEP-31 Monitoring
SEP31_MONITOR_CRON="* * * * *"  # Every minute
```

## API Usage

### Create Transaction
```bash
POST /sep31/transactions
Content-Type: application/json

{
  "amount": "100.00",
  "asset_code": "USD",
  "sender_id": "sender-123",
  "receiver_id": "receiver-456",
  "fields": {
    "transaction": {
      "receiver_routing_number": "123456789",
      "receiver_account_number": "987654321",
      "type": "SWIFT"
    }
  }
}
```

### Get Transaction Status
```bash
GET /sep31/transactions/:id
```

## Monitoring & Jobs

- **SEP-31 Monitor Job**: Runs every minute to check for received payments and update transaction statuses
- **Automatic Status Progression**: Transactions automatically move through SEP-31 states based on payment confirmation

## Acceptance Criteria Met

- ✅ **Passes Stellar SEP-31 Validator**: Full protocol compliance
- ✅ **Metadata Correctly Persisted**: All SEP-31 data stored in transaction metadata
- ✅ **Cross-Border Payments**: Complete payment flow from sender to receiver
- ✅ **Status Management**: Proper state transitions and monitoring

## Testing

The implementation includes comprehensive tests for:
- SEP-31 endpoint validation
- Transaction creation and status updates
- Fee calculation
- Metadata persistence
- State machine transitions

Run tests with:
```bash
npm test -- --testPathPattern=sep31
```