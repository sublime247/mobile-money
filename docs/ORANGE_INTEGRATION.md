# Orange Money Integration

This document describes the implemented Orange Money provider integration for the Mobile Money backend.

Overview

- File: `src/services/mobilemoney/providers/orange.ts`
- Purpose: Authenticate with Orange using OAuth2 (client_credentials), request collection (payment), check status, and perform disbursements (payouts).

Environment variables

- `ORANGE_BASE_URL` (optional): Base URL for Orange API. Defaults to `https://sandbox.orange.com`.
- `ORANGE_API_KEY`: Client ID / API key (required).
- `ORANGE_API_SECRET`: Client secret (required).
- `ORANGE_CURRENCY` (optional): Currency code used for requests. Defaults to `XAF`.
- `ORANGE_USE_HEADLESS_BROWSER`: Use Playwright for web session login to handle JavaScript challenges and CAPTCHAs (default: false)
- `ORANGE_HEADLESS`: Run browser in headless mode (default: true)
- `ORANGE_VIEWPORT_WIDTH`: Browser viewport width (default: 1280)
- `ORANGE_VIEWPORT_HEIGHT`: Browser viewport height (default: 800)
- `ORANGE_USER_AGENT`: Custom user agent string (default: Chrome 120 on Windows)
- `ORANGE_BROWSER_TIMEOUT_MS`: Browser operation timeout in milliseconds (default: 30000)
- `ORANGE_NAVIGATION_TIMEOUT_MS`: Page navigation timeout in milliseconds (default: 30000)

Implemented behavior

- Authentication:
  - Uses client credentials grant (`grant_type=client_credentials`) against `/oauth/token`.
  - Caches access token and refreshes when expired (with small skew).
- requestPayment(phoneNumber, amount):
  - Calls `POST /v1/payments/collect` with a generated reference and transaction details.
  - Returns `{ success: boolean, data?, error?, reference? }`.
- checkStatus(reference):
  - Calls `GET /v1/payments/{reference}` and returns `{ success: boolean, data?, error? }`.
- sendPayout(phoneNumber, amount):
  - Calls `POST /v1/payments/disburse` with generated reference.
  - Returns `{ success: boolean, data?, error?, reference? }`.
- Retries:
  - Transient errors (HTTP 5xx, network/timeouts) are retried with exponential-ish backoff (linear backoff based on attempt).

Notes & limitations

- Endpoints (`/oauth/token`, `/v1/payments/collect`, `/v1/payments/disburse`, `/v1/payments/{ref}`) are implemented as reasonable defaults commonly used by payments APIs, but you must confirm the exact Orange API paths and payload shapes against Orange's official documentation for your region/sandbox before using in production.
- Error shapes returned by Orange are forwarded in the `{ error }` field. The service using this provider should inspect `error.response.data` to extract provider error details.
- The implementation uses `ORANGE_BASE_URL` so you can point to sandbox or production endpoints via environment configuration.

Sandbox testing

1. Ensure `ORANGE_API_KEY` and `ORANGE_API_SECRET` are set in your `.env`.
2. Set `ORANGE_BASE_URL` to the sandbox base URL provided by Orange (if different from the default).
3. Start the app (`npm run dev`) and call the endpoints via existing transaction flows (e.g., `POST /api/transactions/deposit` with `provider: "orange"`).
4. Use `GET /api/transactions/:id` to follow job status and `checkStatus` will be invoked by background jobs if configured.

Next steps (recommended)

- Confirm exact Orange API endpoint paths and payload fields and adjust the request shapes in `orange.ts` accordingly.
- Add unit/integration tests that mock Orange responses (happy path, 4xx errors, 5xx transient errors) and assert retry/handling.
- Add stronger typed models for provider responses if desired.
