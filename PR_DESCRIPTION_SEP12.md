# SEP-12 KYC API Implementation

## Overview
Implements SEP-12 (KYC API) standard for handling customer information dynamically, enabling Stellar wallets to collect and verify user KYC data.

## Changes
- ✅ Implemented `PUT /customer` - Create/update customer information
- ✅ Implemented `GET /customer` - Retrieve customer KYC status
- ✅ Implemented `DELETE /customer` - Remove customer data (GDPR)
- ✅ Mapped internal KYC system to SEP-12 status codes
- ✅ Added database migration for `stellar_address` and `kyc_applicants` table
- ✅ Integrated with existing Entrust/Onfido KYC service

## Testing
- 15/15 tests passing
- Covers all endpoints and status mappings
- Tests for natural person and organization types

## Acceptance Criteria
- ✅ KYC statuses are synchronized between internal system and SEP-12
- ✅ Ready for Stellar validator testing
- ✅ Rate limiting: 20 requests/minute
- ✅ Supports document uploads for ID verification

## Documentation
See `docs/SEP12_KYC_API.md` for full API documentation and usage examples.

## Files Changed
- `src/stellar/sep12.ts` - Main SEP-12 implementation
- `src/stellar/__tests__/sep12.test.ts` - Test suite
- `src/index.ts` - Router registration
- `database/migrations/20260327_add_sep12_support.sql` - Database schema
- `docs/SEP12_KYC_API.md` - Documentation
