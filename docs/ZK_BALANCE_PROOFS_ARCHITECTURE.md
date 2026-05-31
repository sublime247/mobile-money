# ZK Balance Proofs — Architectural Proposal

**Related:** [ZK_BALANCE_PROOFS_RESEARCH.md](./ZK_BALANCE_PROOFS_RESEARCH.md) · **Prototype:** [src/crypto/zkBalanceProof.ts](../src/crypto/zkBalanceProof.ts) · **Scope:** Phases P1 (commitment-only pilot) and P2 (range proofs) of the privacy roadmap.

This document specifies _how_ Mobile Money integrates the primitives surveyed in the research doc into its production stack. It does not dictate what gets shipped when — that's the roadmap in the research doc — but it defines the component boundaries, storage layout, API surface, and failure modes so that P1 and P2 can be executed without re-litigating fundamentals.

---

## 1. Goals and non-goals

**Goals**

- Every user's balance has a published Pedersen commitment that is safe to expose to external counterparties.
- The backend can, on demand, generate a ZK opening or range proof for that commitment without giving up the plaintext balance.
- A counterparty with the commitment and the proof can independently verify the statement with zero trust in us beyond our commitment-publication signing key.
- No change to existing payment, KYC, or settlement flows until the new surface is explicitly opted into.

**Non-goals (in this proposal)**

- Unlinkability / mixer-style privacy pools — deferred to P4.
- On-chain (Soroban) verification — deferred; see §7.
- Reducing the existing plaintext retention footprint (compliance requires it).

---

## 2. Component map

```
 ┌──────────────────────┐         ┌────────────────────────────────┐
 │    User Wallet App   │         │        Mobile Money API        │
 │ (mobile / web)       │         │                                │
 │                      │         │  ┌──────────────────────────┐  │
 │  ┌────────────────┐  │         │  │  ZkProofService (new)    │  │
 │  │ ZkProver (WASM)│──┼────────▶│  │  - opening proofs        │  │
 │  │ (Rust BPs)     │  │         │  │  - equality proofs       │  │
 │  └────────────────┘  │         │  │  - range proofs (P2)     │  │
 │                      │         │  └──────────────────────────┘  │
 └──────────────────────┘         │              │                 │
                                  │              ▼                 │
                                  │  ┌──────────────────────────┐  │
                                  │  │ BalanceCommitmentService │  │
                                  │  │ (publishes C after every │  │
                                  │  │  balance mutation)       │  │
                                  │  └──────────────────────────┘  │
                                  │              │                 │
                                  │     ┌────────┴────────┐        │
                                  │     ▼                 ▼        │
                                  │  PostgreSQL        Event bus   │
                                  │ (commitments,     (subscribers)│
                                  │  blinding, proofs)             │
                                  └────────────────────────────────┘
                                                  │
                                                  ▼
                                      ┌────────────────────────┐
                                      │  Counterparty / Verifier│
                                      │  (merchant, anchor,     │
                                      │  lender, partner bank)  │
                                      └────────────────────────┘
```

**New code** (three new modules, one new table):

1. `src/services/balanceCommitmentService.ts` — publishes a Pedersen commitment on every balance change.
2. `src/services/zkProofService.ts` — wraps the prototype primitives (and later, the Bulletproofs WASM binding) behind a stable interface.
3. `src/routes/zk.ts` — `/api/v1/zk/*` HTTP endpoints.
4. `database/migrations/*_create_zk_balance_commitments_table.sql` — persistent store for the commitment chain.

**Untouched:** the existing `users`, `transactions`, balance adjustment, and settlement paths. ZK runs _alongside_ them, reading from them but never writing to them.

---

## 3. Storage layout

### `zk_balance_commitments`

One row per user per balance-changing event. Append-only; old rows are retained for audit and rebuild.

| Column                     | Type                        | Notes                                                                                    |
| -------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| `id`                       | `BIGSERIAL`                 | PK                                                                                       |
| `user_id`                  | `UUID`                      | Index: `(user_id, created_at DESC)`                                                      |
| `commitment_hex`           | `VARCHAR(66)`               | SEC1-compressed secp256k1 / Ristretto255 point (prototype = secp256k1). Safe to publish. |
| `blinding_enc`             | `BYTEA`                     | Blinding factor, encrypted with the DB encryption key (same scheme as `phone_number`)    |
| `scheme`                   | `VARCHAR(32)`               | e.g. `pedersen-secp256k1-v1`, `pedersen-ristretto255-v1`                                 |
| `triggering_tx_id`         | `UUID NULL`                 | FK → `transactions.id`; null for admin adjustments or bootstrap                          |
| `supersedes_commitment_id` | `BIGINT NULL`               | Self-FK: each new row points at the one it replaced                                      |
| `published_at`             | `TIMESTAMPTZ`               | When we signed and (optionally) posted to an event feed                                  |
| `signing_key_id`           | `VARCHAR(64)`               | Which commitment-publisher key signed this row's audit record                            |
| `created_at`               | `TIMESTAMPTZ DEFAULT NOW()` |                                                                                          |

**Blinding storage.** For P1 we store encrypted blinding factors server-side so the API can produce proofs without the user online. In P4 (privacy pools) this moves to device-held keys; the schema anticipates that migration by making `blinding_enc` nullable.

**Why append-only:** regulators need a verifiable chain. Rebuilding `C_balance = Σ C_mutation_i` lets auditors sanity-check a user's history from commitments alone.

---

## 4. API surface

All endpoints live under `/api/v1/zk/` and require the standard JWT + `X-API-Key` auth used elsewhere.

### P1 — commitment-only pilot

| Method | Path                  | Purpose                                                                                                                                                           |
| ------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/commitment/:userId` | Latest commitment + scheme version + `published_at`                                                                                                               |
| `POST` | `/opening-proof`      | Body: `{ userId, nonce }`. Returns a Sigma opening proof bound to `nonce` for the caller to verify                                                                |
| `POST` | `/equality-proof`     | Body: `{ userId, externalCommitmentHex }`. Proves the stored commitment and an externally-held commitment open to the same value. Primary use: anchor cross-check |

**Nonce binding.** Every opening/equality request supplies a fresh 32-byte caller-side nonce. The Fiat-Shamir challenge is computed over `H(C ‖ T ‖ nonce)`; this is what prevents proof replay. The nonce is **required** — requests without it are 400.

**Response shape (opening proof):**

```json
{
  "userId": "...",
  "commitment": "02a1b2...",
  "scheme": "pedersen-secp256k1-v1",
  "proof": {
    "T": "02c3d4...",
    "z1": "a5b6...",
    "z2": "c7d8..."
  },
  "nonce": "caller-supplied-32-bytes-hex",
  "publishedAt": "2026-04-24T12:00:00Z"
}
```

### P2 — range proofs

| Method | Path            | Purpose                                                                                                                                            |
| ------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/range-proof`  | Body: `{ userId, threshold, direction: "geq" \| "leq", nonce }`. Returns a Bulletproof showing `balance ≥ threshold` (or `≤`) without revealing it |
| `POST` | `/verify-range` | Body: `{ commitmentHex, threshold, direction, proof, nonce }`. Stateless verifier endpoint (useful for partners without their own library)         |

**Range semantics.** Ranges are expressed in minor units (XAF centimes, stroops for XLM). The proof commits to `delta = balance − threshold` and shows `delta ∈ [0, 2^64)`. 64-bit is enough for any realistic money-market value; the constant is part of the scheme version.

---

## 5. Protocol flows

### 5.1 Commitment rotation on every balance change

```
transaction commits (pg txn)
    │
    ├─ update user balance row            ← existing path
    │
    └─ NOTIFY 'balance_changed' (user_id)
           │
           ▼
    balanceCommitmentService (worker)
       1. load fresh balance B from DB
       2. sample blinding r ←$ [0, n)
       3. compute C = B·G + r·H
       4. sign { user_id, C, timestamp, key_id } with commitment-publisher key
       5. INSERT into zk_balance_commitments (supersedes = previous.id)
       6. publish C on event bus (subscribers: audit log, anchor webhooks)
```

The worker is idempotent on `triggering_tx_id` — replays don't produce duplicate rows.

### 5.2 User requests an opening proof for a merchant

```
user wallet  ──(1) nonce ─────────▶ merchant
merchant     ──(2) nonce ─────────▶ Mobile Money /api/v1/zk/opening-proof
MM backend   ──(3) load C, r ─────▶ PostgreSQL
MM backend   ──(4) compute proof ─▶ (Sigma protocol w/ Fiat-Shamir over nonce)
MM backend   ──(5) proof ─────────▶ merchant
merchant     ──(6) verify(C, proof, nonce) locally with @noble/curves
merchant     ──(7) accept / decline
```

Step (6) runs in the merchant's own environment with a published verifier library. The merchant never talks to our DB, never sees the balance, never sees `r`.

### 5.3 Cross-ledger equality (P3 preview)

Two commitments exist: `C_mm` on our side and `C_anchor` published by a SEP-31 anchor. The anchor and our backend each hold their own blinding. The user or a third-party auditor requests the equality proof:

```
auditor ──▶ anchor      : give me C_anchor + (r1 − r2)_anchor share
auditor ──▶ MM backend  : give me C_mm + (r1 − r2)_mm share
auditor                 : assemble the Schnorr proof on H from both shares
auditor                 : verify locally
```

This is a two-party MPC variant of the equality protocol in [the prototype](../src/crypto/zkBalanceProof.ts). Building the MPC coordination is the P3 lift; the crypto itself is the existing equality proof.

---

## 6. Curve + library migration plan

| Step | When         | Change                                                                                                                                                                                         |
| ---- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | During P1    | Pin prototype to `pedersen-secp256k1-v1`. Ship with `elliptic` behind the service interface.                                                                                                   |
| 2    | Before P1 GA | Replace `elliptic` with `@noble/curves` (still secp256k1). Bump `scheme` to `pedersen-secp256k1-v2`. Automated rewrite at rotation time (next balance change writes the new scheme).           |
| 3    | Start of P2  | Add `pedersen-ristretto255-v1` as a parallel scheme. Bulletproofs verifier is keyed to this curve. Commitments for new users default to Ristretto255; existing users migrate on next rotation. |
| 4    | End of P2    | Deprecate secp256k1 schemes (90-day sunset with counterparty notice).                                                                                                                          |

Because every commitment carries its `scheme` column, multiple schemes can coexist mid-migration without ambiguity. Verifiers select the right curve/library by scheme tag.

---

## 7. Why verification is off-chain

Soroban as of Stellar Core 21 exposes no ZK-verification precompile and no BLS12-381 pairing op. A Bulletproof verifier in pure Soroban WASM costs > 100 M CPU units per call, well past the 100 M per-op soft cap. Consequences:

- **Verifier lives in the Mobile Money backend, merchant SDKs, and counterparty services** — anywhere off-chain where the receiver can run pure-JS / Rust.
- **Commitments are anchored on-chain only as hashes** (via `manageData` operations on Stellar) when a tamper-evident trail is needed. This preserves auditability without paying verification cost.
- **If Stellar ships native Groth16/BLS precompiles** (tracked as Soroban RFC; see research doc §8), we revisit moving verification on-chain for high-trust flows. The `scheme` column + migration plan above give us room to layer that in non-breakingly.

---

## 8. Failure modes and mitigations

| Failure                           | Blast radius                                                                                                                                      | Mitigation                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Commitment publisher key stolen   | Attacker mints fake commitment rows. Verifiers still check signatures before trusting a `C`; legitimate commitments remain valid.                 | Key in HSM; rotate via `signing_key_id`; event bus signs every published commitment                  |
| Blinding-factor ciphertext leaked | Attacker can link commitments to balances for any user whose `blinding_enc` leaked. Past hiding is broken; future commitments (new `r`) are fine. | Same DB encryption key used for phone/email; rotate on incident; re-commit all affected users        |
| RNG weakness                      | Same `r` for two commitments → subtract to recover `v1 − v2`. Catastrophic for hiding.                                                            | Use `crypto.randomBytes` (Node) or the platform's CSPRNG; reject low-entropy environments at startup |
| Service down when proof requested | Merchant can't accept a transaction.                                                                                                              | 5s SLA, circuit-breaker; merchant-side fallback to cached recent commitment + stale-proof disclosure |
| Proof replay                      | Counterparty re-uses an old proof against a different nonce.                                                                                      | Nonce is required input to the Fiat-Shamir challenge — an old proof fails against any new nonce      |

---

## 9. Rollout & feature flags

- `FEATURE_ZK_COMMITMENT_PUBLISH` — master switch for the commitment worker. Off by default; enables dual-write of every balance change.
- `FEATURE_ZK_OPENING_PROOF_API` — gates the `/api/v1/zk/opening-proof` and `/equality-proof` endpoints. Requires commitments to be published for at least 7 days before enabling.
- `FEATURE_ZK_RANGE_PROOF_API` — gates the P2 Bulletproofs endpoints.

Each flag is tied to a partner allow-list so a single merchant can pilot without a general rollout. Existing flag/feature infrastructure (see `src/config/featureFlags.ts` — to be created as part of P1) applies.

---

## 10. Open design questions (for P1 kickoff)

1. **Publish to event bus?** Do we broadcast every commitment to all subscribers, or only on explicit anchor/merchant pull? Leaning pull-based for P1 to avoid leaking tx frequency.
2. **Scheme for blinding rotation.** Do we keep `r` stable across balance updates (simplifies equality across time) or rotate on every write (better unlinkability but breaks prior-commitment equality)? Leaning _rotate_ and expose a separate "historical equality proof" API when needed.
3. **Who owns the commitment signing key?** Options: Treasury HSM (operationally safest), dedicated service KMS (simplest), rotating per-region keys (best for blast-radius containment). Leaning regional KMS w/ 30-day rotation.
4. **Denomination.** Do commitments carry a currency tag or is each user's commitment scoped to their primary currency only? Multi-currency users will break a scalar-only commitment scheme; leaning one commitment per (user, currency) pair, tracked by scheme suffix.

These unblock during P1 design review and are called out here so reviewers know what is and isn't settled.
