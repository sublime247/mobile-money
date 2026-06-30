# Zero-Knowledge Balance Proofs — Research Notes

**Issue:** [#531](https://github.com/sublime247/mobile-money/issues/531) · **Status:** Research · **Scope:** Privacy-enhancing roadmap

This document surveys the ZK techniques available for proving facts about a user's balance _without revealing the balance itself_, evaluates each option against Mobile Money's constraints (Stellar + off-chain mobile-money rails, mid-2026 tooling landscape), and recommends a staged adoption path. A companion prototype lives at [src/crypto/zkBalanceProof.ts](../src/crypto/zkBalanceProof.ts) and a production architecture in [ZK_BALANCE_PROOFS_ARCHITECTURE.md](./ZK_BALANCE_PROOFS_ARCHITECTURE.md).

---

## 1. What are we actually trying to prove?

Three concrete user-visible statements, in rough order of product priority:

| #      | Statement                                                                    | Example use                                                                                                  |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **S1** | _"My balance equals the value I'm asserting."_                               | User convinces a counterparty/merchant of a specific amount without disclosing their full balance or history |
| **S2** | _"My balance is ≥ T."_                                                       | Eligibility: limits, lending, KYC tiers, merchant minimums                                                   |
| **S3** | _"The balance my bank sees matches the one the Stellar ledger/anchor sees."_ | Cross-ledger consistency; fraud detection without a shared plaintext balance                                 |

Statements **S1** and **S3** are solvable with Sigma protocols (small constant-size proofs, milliseconds to produce, no trusted setup). **S2** is a **range proof** — the hard one, and the one that drives the choice of scheme.

---

## 2. Scheme landscape

| Scheme                        | Proof size                                 | Prover time | Verifier time | Setup                                  | Good for                     |
| ----------------------------- | ------------------------------------------ | ----------- | ------------- | -------------------------------------- | ---------------------------- |
| **Sigma protocols / Schnorr** | O(1) (small, ~100 B)                       | <1 ms       | <1 ms         | None                                   | S1, S3, bit proofs           |
| **Bulletproofs**              | O(log n) (~1 KB for 64-bit)                | ~30 ms      | ~15 ms        | None                                   | S2 range proofs ⭐           |
| **Bulletproofs+**             | O(log n) (~20 % smaller than Bulletproofs) | ~30 ms      | ~15 ms        | None                                   | S2 (drop-in upgrade)         |
| **Groth16 zk-SNARK**          | O(1) (~200 B)                              | ~seconds    | ~ms           | Trusted setup (per circuit)            | S2 at scale, privacy pools   |
| **PLONK / Halo2**             | O(log n) (~1–2 KB)                         | ~seconds    | ~ms           | Universal trusted setup or transparent | Flexible circuits, long-term |
| **STARKs**                    | O(log² n) (~50 KB)                         | ~seconds    | ~ms           | None (hash-based)                      | Post-quantum, long-term      |

**Soroban / Stellar fit:** Stellar's Soroban runtime (WASM-based) has no native ZK verifier precompiles as of 2026 Q1. A smart-contract range-proof verifier is prohibitive: Bulletproofs verification in pure WASM costs multiple MCPU-seconds per proof, which exceeds Soroban's current per-op budget. **Practical implication: verification lives off-chain in our backend; on-chain we commit to the _commitment_ and the _proof-verified flag_, not the proof itself.**

---

## 3. Curve & library choices

**Curve — Ristretto255 (recommended for production).** Ed25519-family primitives are everywhere in the Stellar ecosystem, but Ed25519's curve has a cofactor of 8, which complicates sigma protocols (subgroup attacks, malleability). Ristretto255 is a prime-order abstraction built on Curve25519 that removes the cofactor cleanly while staying compatible with Ed25519-style hashing. For the prototype we used secp256k1 (prime order, transitively available via `stellar-sdk → elliptic`), which is fine for a reference but not ideal for production because it is not natively used anywhere else in the stack.

**Libraries shortlist (mid-2026):**

| Library                                                      | Notes                                                                                                                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@noble/curves`](https://github.com/paulmillr/noble-curves) | Audited, tiny, pure-JS; exposes Ristretto255, secp256k1, ed25519. **Top pick for production.**                                                                  |
| `dalek-cryptography/bulletproofs` (Rust)                     | Reference Bulletproofs implementation. Deploy via WASM for the Node service.                                                                                    |
| `snarkjs` + `circom`                                         | Groth16/PLONK toolchain. Heavy, but mature; good for the long-horizon "privacy pool" roadmap.                                                                   |
| `elliptic`                                                   | Older, widely used, already in our tree. Kept for the prototype; not recommended for production due to no constant-time guarantees and a thinner audit history. |

**Hashing:** SHA-256 for Fiat-Shamir throughout (no reason to reach for Keccak or Poseidon at this layer; Poseidon only matters once we move inside a SNARK circuit).

---

## 4. Prototype deliverables

The file [src/crypto/zkBalanceProof.ts](../src/crypto/zkBalanceProof.ts) implements the four primitives that cover **S1**, **S3**, and the bit-decomposition building block for **S2**:

1. **Pedersen commitment** — `C = v·G + r·H`, perfectly hiding, computationally binding.
2. **ZK proof of opening** — Schnorr/Sigma proof that the prover knows `(v, r)` for a given `C`. Non-interactive via Fiat-Shamir.
3. **ZK equality of two committed values** — prove `C1` and `C2` commit to the same `v` under different blindings. Enables cross-ledger consistency (S3).
4. **ZK proof that `C` commits to a bit** — Chaum-Pedersen OR-proof. The atomic building block for bit-decomposition range proofs.

Tests live in [tests/crypto/zkBalanceProof.test.ts](../tests/crypto/zkBalanceProof.test.ts) — 17 cases, covering correctness, hiding, soundness (forged proofs, tampered commitments/responses), additive homomorphism, and an end-to-end scenario.

**What the prototype deliberately does NOT ship:**

- A full range proof. The bit primitive is demonstrated; chaining it across `n` bits is straightforward (`C_balance = Σ 2^i · C_bit_i + C_remainder`) but the proof size is O(n) and in production we want Bulletproofs' O(log n).
- Constant-time operations. `elliptic` is not a constant-time library. Any production code path processing an attacker-controlled balance must move to `@noble/curves` (or a Rust/WASM Bulletproofs verifier) first.
- Wire-format stability. Points are serialised SEC1-compressed, scalars big-endian 32 bytes — good enough for tests, not binding as a protocol.

---

## 5. Threat model

| Assumption                                            | Notes                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Discrete-log hardness on secp256k1 / Ristretto255** | Standard. Breaks if large-scale quantum computing lands before STARKs are the default.                                                                                                                                                                        |
| **Fiat-Shamir soundness**                             | Safe because SHA-256 remains a random oracle for attackers. Transcript ordering matters — the code fixes it.                                                                                                                                                  |
| **Generator `H` has unknown discrete log w.r.t. `G`** | We derive `H` by hashing a fixed label to a curve point, which is standard. For production, codify the generation procedure in a spec and pin the label.                                                                                                      |
| **Nonce (blinding) entropy**                          | Every commitment needs a fresh, uniformly-random blinding. The prototype uses `ec.genKeyPair()` which rejection-samples from `crypto.randomBytes`. If we ever deploy a CSPRNG-weak path (e.g. VM with poor entropy), commitments become linkable across uses. |

### Explicitly out of scope for the prototype

- **Network-level privacy.** ZK proofs protect content, not metadata. If the backend sees `userId + commitment + proof`, the user is still fully identified. Mixing and unlinkability require a separate design (Tornado Cash-style privacy pools — listed in §7 roadmap).
- **Side-channel resistance.** Timing variance from `elliptic` can leak bits of secrets on shared hardware.
- **Proof aggregation.** Aggregating many users' range proofs into a single verification is a Bulletproofs feature we are _not_ using yet.

---

## 6. Integration constraints specific to Mobile Money

1. **Balance lives off-ledger.** The canonical balance is in PostgreSQL (`users`/`transactions`); Stellar is used for settlement, not account state. ZK proofs therefore attest to a commitment published by our backend, not to a value on a public ledger — this simplifies verification (we trust our own commitment service) but means we **must audit the commitment-publication pipeline as carefully as any signing key**.
2. **Low-trust mobile clients.** Provers run on user phones via the wallet. Prover performance must stay under ~200 ms on a mid-range Android device to avoid UX degradation. Bulletproofs at 64-bit range proofs hits this on modern hardware; Groth16 SNARKs do not (seconds).
3. **Regulatory logging (Cameroon / CEMAC / GDPR).** We are legally required to retain the _fact_ and _amount_ of transactions for audit — we can encrypt them, but we cannot simply throw them away. ZK proofs therefore layer on top of current storage: commitments + proofs are an _additional_ privacy-preserving surface, not a replacement for the plaintext audit trail.
4. **Anchor interop (SEP-24 / SEP-31).** Anchors require disclosed amounts for on/off-ramp flows. ZK proofs only apply to in-network operations (P2P transfers, merchant eligibility, tier checks) where both ends of the flow trust the same commitment-verification authority.

---

## 7. Recommended roadmap

| Phase                                | Deliverable                                                                                                                                                                                                                                               | Trigger                                                       | Effort    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------- |
| **P0 — Research** (this PR)          | Prototype + docs                                                                                                                                                                                                                                          | Issue #531                                                    | ✅ done   |
| **P1 — Commitment-only pilot**       | Publish a Pedersen commitment to each user's balance alongside the plaintext column, rotate on every balance change. Expose `POST /api/v1/zk/opening-proof` that returns a Sigma opening proof bound to a caller-supplied nonce. Consumers: merchant SDK. | P0 accepted; product decides first consumer                   | 2–3 weeks |
| **P2 — Range proofs (Bulletproofs)** | Drop in a Rust/WASM Bulletproofs verifier. Expose `prove_balance_geq(T)` + `verify` endpoints. Consumer: tiered-KYC eligibility, lending pre-qualification.                                                                                               | At least one P1 consumer live; product wants threshold checks | 6–8 weeks |
| **P3 — Cross-ledger equality**       | Ship the equality-of-openings proof for anchor flows. Prove the balance on our ledger matches a committed value published by the anchor, without either side revealing it.                                                                                | SEP-31 partner asks for it                                    | 3–4 weeks |
| **P4 — Privacy pool (long horizon)** | Merkle-tree of commitments + Groth16 membership proofs. Unlinkable transfers within the pool. Heavy lift: circuit design, trusted setup ceremony, regulator sign-off.                                                                                     | Regulatory clarity on mixers; 12+ months out                  | Large     |

**Success criteria per phase:** P1 — proof generation <20 ms in-service, <300 ms on mobile; zero regressions in merchant checkout latency. P2 — 64-bit range proof <50 ms verify in Node, <200 ms prove on mid-range Android. P3 — end-to-end equality proof roundtrip <1 s across anchor network.

---

## 8. Open questions (parking lot)

1. **Commitment key custody.** Who owns the secret blinding factors? Per-user on device (good for privacy, bad for recovery) vs. HSM-backed service (worse for privacy, trivial recovery). Likely: hybrid — device-held for S2, service-held for S3.
2. **Soroban ZK precompiles.** Stellar Core 22 ([design doc][soroban-zk]) floats native BLS12-381 pairings and Groth16 verification. If and when that ships, the P3→P4 roadmap compresses dramatically.
3. **Proof replay.** Every proof must bind a per-request nonce (challenge includes it). The prototype does not demonstrate nonce handling — it is deferred to P1.
4. **Formal verification.** We should formalise the commitment scheme in Tamarin or ProVerif before P2. Estimated cost: 2–3 weeks of a cryptography consultant.

---

## 9. References

- Bünz et al., _Bulletproofs: Short Proofs for Confidential Transactions and More_, IEEE S&P 2018.
- Chaum & Pedersen, _Wallet Databases with Observers_, CRYPTO '92 (OR proofs).
- Fiat & Shamir, _How To Prove Yourself_, CRYPTO '86.
- Hamburg, _Decaf: Eliminating Cofactors Through Point Compression_, CRYPTO 2015 (Ristretto basis).
- Noble Cryptography — [github.com/paulmillr/noble-curves](https://github.com/paulmillr/noble-curves)
- Dalek Bulletproofs — [github.com/dalek-cryptography/bulletproofs](https://github.com/dalek-cryptography/bulletproofs)
- Stellar Soroban ZK RFC — [link tbd][soroban-zk]

[soroban-zk]: https://github.com/stellar/stellar-protocol/discussions/zk
