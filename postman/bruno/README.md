# Bruno Collection — Mobile Money Bridge API

Turnkey [Bruno](https://usebruno.com) collection for the mobile-money bridge API,
equivalent to the Postman collection in `postman/mobile-money-bridge.json`, with one
important upgrade: **the SEP-10 challenge is fetched, signed and verified automatically
inside a pre-request script** — no manual XDR copying.

## What's inside

```text
postman/bruno/
├── bruno.json              collection manifest (CommonJS module system)
├── package.json            pins @stellar/stellar-sdk for the scripts
├── package-lock.json       reproducible installs (npm --prefix postman/bruno ci)
├── environments/
│   └── Local.bru           base_url + throwaway Stellar keypair + runtime vars
├── scripts/
│   └── sep10.js            fetchChallenge / signChallenge / decodeJwtPayload
├── mock/
│   └── bridge-mock.cjs     backend stand-in for smoke runs (npm run bruno:mock)
├── 00-health/              /health, /ready
├── 01-auth/                SEP-10 challenge → JWT, login, verify, /me
├── 02-kyc/                 SEP-12 customer + /api/kyc status
├── 03-quotes/              SEP-38 info, prices, quotes + /api/fees/estimate
├── 04-deposits/            SEP-24 info/interactive deposit + core collection
└── 05-withdrawals/         SEP-24 payout + core payout, transaction lookups
```

Every request ships a `tests { … }` block with at least one assertion, and
state-producing requests store their results back into environment variables
(`jwt_token`, `quote_id`, `transaction_id`, …) so the next request just works.

## Quick start

### 1. Install the script dependencies

The SEP-10 helper requires `@stellar/stellar-sdk` from the collection's own
`package.json`:

```bash
npm run bruno:install      # → npm --prefix postman/bruno ci
```

The collection pins `@stellar/stellar-sdk@15.1.0` (the backend itself runs on
`^17`). Bruno's developer sandbox loads npm packages through a CommonJS VM, and
stellar-sdk 16+ pulls in `uint8array-extras`, an ESM-only package that fails with
`SyntaxError: Unexpected token 'export'`. Only bump this pin once Bruno can load
ESM modules.

### 2a. Run with the Bruno desktop app

1. Open the `postman/bruno` folder as a collection (`Open Collection` → folder).
2. Enable **Settings → Developer Mode** — required so `require("@stellar/stellar-sdk")`
   is allowed in scripts.
3. Select the `Local` environment.
4. Click **Run** on `01-auth` (or the whole collection), in order.

### 2b. Run with the CLI

```bash
npm run bruno:run
# → cd postman/bruno && npx --yes --package=@usebruno/cli bru run . -r \
#      --env Local --sandbox=developer
```

`--sandbox=developer` is the CLI counterpart of Developer Mode and is required for
npm package requires. Requests are executed top-to-bottom (`00-health` → `05-withdrawals`),
so the token issued by SEP-10 is available to everything after `01-auth`.

## How SEP-10 auto-signing works

`01-auth/sign-challenge-get-token.bru` runs this in `script:pre-request`:

1. `sep10.fetchChallenge(...)` — `bru.sendRequest("GET /sep10?account=…")` pulls a
   fresh challenge XDR from the running server.
2. `sep10.signChallenge(challenge, stellar_secret_key)` —
   `TransactionBuilder.fromXDR` + `Keypair.sign`, exactly like a production client.
3. `req.setBody({ transaction: signedXdr })` — the request posts the signed XDR,
   and `tests { … }` asserts the returned JWT subject equals your public key.

The signed XDR is cached in `{{signed_challenge_xdr}}`. In sandboxes where
`bru.sendRequest` is unavailable, the fallback two-step flow works identically:

1. Run `01-auth/get-challenge.bru` — its `script:post-response` signs the response
   and stores the result.
2. Run `01-auth/sign-challenge-get-token.bru` — it reuses the cached signature.

### The bundled keypair

`environments/Local.bru` ships a **valid-format throwaway Stellar keypair** so the
collection runs out of the box:

```text
stellar_public_key  GDPVUUPDJPSOZUPLRUKCWPDZSTSCY3KPCAHBCE7FCQVQW65ZHSBE4ZYS
stellar_secret_key  SD6KTHWH6JJ3Y3DGDNA7MJIHSHCRFXUXE4QVVFCNCH2EX7UZ3USV3XAR
```

Replace `stellar_public_key` **and** `stellar_secret_key` together for anything
beyond local development — they must correspond to each other. Never paste a funded
production key into a collection that lives in git (see `docs/DISASTER_RECOVERY.md`
for the key-rotation procedure).

## Environment variables (`environments/Local.bru`)

* `base_url` — API origin, default `http://localhost:3000`
* `home_domain` — SEP-10 home domain, default `localhost:3000`
* `stellar_public_key` / `stellar_secret_key` — signing pair; they must correspond
  to each other (`vars:secret` is not used: it stores names only, values have to
  come from an external secrets file)
* `login_phone` — MSISDN used by login and core deposit/payout bodies
* `jwt_token`, `challenge_xdr`, `signed_challenge_xdr`, `network_passphrase` —
  written by the auth requests at runtime
* `quote_id`, `transaction_id`, `user_id` — written by quote and transaction requests

## Request map

| Folder         | Request                                | Endpoint                                        |
| -------------- | -------------------------------------- | ----------------------------------------------- |
| 00-health      | Health Check                           | `GET /health`                                   |
| 00-health      | Readiness Check                        | `GET /ready`                                    |
| 01-auth        | SEP-10 Get Challenge                   | `GET /sep10`                                    |
| 01-auth        | SEP-10 Sign Challenge & Get Token      | `POST /sep10`                                   |
| 01-auth        | Login (Phone / OTP)                    | `POST /api/auth/login`                          |
| 01-auth        | Verify Token                           | `POST /api/auth/verify`                         |
| 01-auth        | Get Current User Profile               | `GET /api/auth/me`                              |
| 02-kyc         | SEP-12 Get Customer KYC Status         | `GET /sep12/customer`                           |
| 02-kyc         | SEP-12 Submit Customer KYC Data        | `PUT /sep12/customer`                           |
| 02-kyc         | Get User KYC Status                    | `GET /api/kyc/status`                           |
| 03-quotes      | SEP-38 Get Info & Asset Pairs          | `GET /sep38/info`                               |
| 03-quotes      | SEP-38 Indicative Price Query          | `GET /sep38/prices`                             |
| 03-quotes      | SEP-38 Request Firm Quote              | `POST /sep38/quote`                             |
| 03-quotes      | SEP-38 Get Firm Quote by ID            | `GET /sep38/quote/:id`                          |
| 03-quotes      | Pre-flight Fee Estimation              | `POST /api/fees/estimate`                       |
| 04-deposits    | SEP-24 Get Deposit & Withdrawal Info   | `GET /sep24/info`                               |
| 04-deposits    | SEP-24 Initiate Interactive Deposit    | `POST /sep24/transactions/deposit/interactive`  |
| 04-deposits    | SEP-24 Query Transaction Status        | `GET /sep24/transaction`                        |
| 04-deposits    | Core Direct Mobile Money Collection    | `POST /api/transactions/deposit`                |
| 05-withdrawals | SEP-24 Initiate Interactive Withdrawal | `POST /sep24/transactions/withdraw/interactive` |
| 05-withdrawals | Core Direct Mobile Money Payout        | `POST /api/transactions/withdraw`               |
| 05-withdrawals | Get Transaction Details                | `GET /api/transactions/:id`                     |
| 05-withdrawals | List Transaction History               | `GET /api/transactions`                         |

## Verifying the collection

Static checks (manifest, folders, env vars, auto-signing script, per-request tests)
run with the rest of the collection checks:

```bash
npm run collections:verify
```

To exercise the whole collection — including the SEP-10 signature exchange —
without a backend, start the bundled mock and run the collection against it:

```bash
npm run bruno:mock     # terminal 1 — serves /sep10 and friends on :3000
npm run bruno:run      # terminal 2 — expect 23/23 requests and 41/41 tests
```

`postman/bruno/mock/bridge-mock.cjs` builds and verifies real SEP-10 challenge
transactions (server signature + client signature + timebounds), so a green run
proves the signing path end to end.

## Troubleshooting

* **`Cannot find module '@stellar/stellar-sdk'`** — run `npm run bruno:install`,
  and make sure Developer Mode (GUI) or `--sandbox=developer` (CLI) is enabled.
* **`bru.sendRequest is unavailable`** — your sandbox doesn't expose it; run
  `01-auth/get-challenge.bru` first, then `sign-challenge-get-token.bru`.
* **Challenge expired** — SEP-10 challenges carry short time bounds; re-run
  `sign-challenge-get-token.bru` to fetch a fresh one (it never reuses a stale XDR).
* **`jwt_token is empty`** — a guarded pre-request threw on purpose; run `01-auth`
  before the folders that need a token.
* **`SyntaxError: Unexpected token 'export'`** — a stellar-sdk version newer than
  15 is being loaded; reinstall with `npm run bruno:install`.
* **Query parameters missing from the request** — `bru` CLI 4.x parses but does not
  apply `params:query` blocks, so this collection writes query strings inline in the
  `url` (`…/sep10?account={{stellar_public_key}}`).
* **`require()` paths** — Bruno resolves local modules relative to the collection
  root, not the request folder, hence `require("./scripts/sep10")`.
