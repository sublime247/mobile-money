# Observability probes and signed reports

## Synthetic testnet transaction

The synthetic probe is disabled by default. Enable it only when a dedicated
testnet runner and funded test wallet are available:

```env
SYNTHETIC_PROBE_ENABLED=true
STELLAR_NETWORK=testnet
SYNTHETIC_PROBE_URL=https://<testnet-runner>/synthetic-roundtrip
SYNTHETIC_PROBE_TOKEN=<runner-token>
```

The runner receives a JSON POST with `amount: "0.01"`, `network: "testnet"`,
and `lifecycle: ["deposit", "withdrawal"]`. It must execute and confirm both
legs, then return completed statuses and transaction IDs:

```json
{
  "deposit": { "status": "completed", "transactionId": "..." },
  "withdrawal": { "status": "completed", "transactionId": "..." }
}
```

The API worker invokes the runner immediately and every five minutes. It
publishes `synthetic_transaction_duration_seconds` and sends a critical Slack
alert after two consecutive failures. The runner should use isolated testnet
accounts and must not be pointed at mainnet.

## Stellar wallet metrics

Set the public keys for the wallet roles that should be scraped:

```env
STELLAR_HOT_WALLET_PUBLIC_KEY=G...
STELLAR_FEE_ACCOUNT_PUBLIC_KEY=G...
STELLAR_ESCROW_POOL_PUBLIC_KEY=G...
```

Wallet account state is refreshed asynchronously every minute. `/metrics`
serves the cached values for sequence number, estimated reserve bytes, base
reserve utilization, XLM balance, and subentry count. Reserve estimates use
`STELLAR_BASE_RESERVE_XLM` (default `0.5`) and
`STELLAR_LEDGER_ENTRY_BYTES` (default `128`).

## CSP frame sources

`STELLAR_WEB_AUTH_DOMAIN` and `SEP24_INTERACTIVE_URL` are normalized to origins
and allowed as frame sources. Additional exact origins can be set in
`CSP_FRAME_SRC` as a comma-separated list. Wildcards, paths, credentials, and
non-HTTPS origins in production are rejected. `frame-ancestors 'none'` remains
in force.

## Signed exports

Provide an RSA PEM private key through `ANCHOR_REPORT_SIGNING_KEY`. Request a
signed CSV or PDF using `GET /export?format=csv&signed=true` or
`GET /export?format=pdf&signed=true`. The response is a ZIP containing the
report, a detached `.sig`, and a `.metadata.json` file with the SHA-256 digest
and RSA-SHA256 signature.

Verify the extracted report and signature with the matching RSA public key:

```sh
momo-cli verify-report settlement.csv settlement.csv.sig anchor-public.pem
```

Alternatively set `ANCHOR_REPORT_PUBLIC_KEY` to the PEM contents and omit the
public-key file argument.
