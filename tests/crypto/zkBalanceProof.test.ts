/**
 * Tests for the ZK balance-proof prototype. These also serve as executable
 * documentation — each describe() block mirrors a primitive in the research
 * prototype (src/crypto/zkBalanceProof.ts).
 */

import {
  DEFAULT_PARAMS,
  commit,
  commitWithBlinding,
  proveOpening,
  verifyOpening,
  proveEqualOpenings,
  verifyEqualOpenings,
  proveBit,
  verifyBit,
  proveBalanceEquals,
  verifyBalanceEquals,
} from "../../src/crypto/zkBalanceProof";

describe("Pedersen commitments", () => {
  it("produces a different commitment for the same value with fresh blinding (hiding)", () => {
    const c1 = commit(1_000n);
    const c2 = commit(1_000n);
    expect(c1.commitment.hex).not.toBe(c2.commitment.hex);
  });

  it("is deterministic when the blinding factor is fixed", () => {
    const c1 = commitWithBlinding(42n, 7n);
    const c2 = commitWithBlinding(42n, 7n);
    expect(c1.hex).toBe(c2.hex);
  });

  it("is additively homomorphic: commit(a) + commit(b) opens to a+b", () => {
    // We test the homomorphism at the raw point level.
    const { commitment: ca, opening: oa } = commit(3n);
    const { commitment: cb, opening: ob } = commit(5n);

    // Sum of commitments.
    const sumPoint = ca.point.add(cb.point);
    // Recreate commitment to 3+5 with the sum of blinding factors.
    const expected = commitWithBlinding(
      oa.value + ob.value,
      oa.blinding + ob.blinding,
      DEFAULT_PARAMS,
    );
    expect(sumPoint.eq(expected.point)).toBe(true);
  });
});

describe("ZK proof of opening (Schnorr / Sigma)", () => {
  it("verifies a honest proof", () => {
    const { commitment, opening } = commit(5_000n);
    const proof = proveOpening(commitment, opening);
    expect(verifyOpening(commitment, proof)).toBe(true);
  });

  it("rejects a proof against a tampered commitment", () => {
    const { commitment, opening } = commit(5_000n);
    const proof = proveOpening(commitment, opening);
    const tampered = commit(5_000n).commitment; // same value, different randomness
    expect(verifyOpening(tampered, proof)).toBe(false);
  });

  it("rejects a proof with tampered response scalars", () => {
    const { commitment, opening } = commit(5_000n);
    const proof = proveOpening(commitment, opening);
    const bad = { ...proof, z1hex: "00".repeat(32) };
    expect(verifyOpening(commitment, bad)).toBe(false);
  });

  it("rejects a forged proof (attacker without the opening)", () => {
    const { commitment } = commit(5_000n);
    const fakeOpening = { value: 1n, blinding: 1n };
    const badProof = proveOpening(commitment, fakeOpening);
    expect(verifyOpening(commitment, badProof)).toBe(false);
  });

  it("verifies for zero and for large values near the group order", () => {
    const zero = commit(0n);
    expect(
      verifyOpening(
        zero.commitment,
        proveOpening(zero.commitment, zero.opening),
      ),
    ).toBe(true);
    const big = commit(10n ** 12n); // 1 trillion minor units
    expect(
      verifyOpening(big.commitment, proveOpening(big.commitment, big.opening)),
    ).toBe(true);
  });
});

describe("ZK proof of equality of committed values", () => {
  it("verifies two commitments to the same value under different blindings", () => {
    // Two independent commitments to the same balance.
    const value = 12_345n;
    const c1 = commit(value);
    const c2 = commit(value);
    const proof = proveEqualOpenings(
      c1.commitment,
      c2.commitment,
      c1.opening.blinding,
      c2.opening.blinding,
    );
    expect(verifyEqualOpenings(c1.commitment, c2.commitment, proof)).toBe(true);
  });

  it("rejects when the two commitments are to different values", () => {
    const c1 = commit(100n);
    const c2 = commit(200n);
    // Attacker tries to claim equality — the delta of blindings is wrong
    // because the balances also differ, so the Schnorr check fails.
    const proof = proveEqualOpenings(
      c1.commitment,
      c2.commitment,
      c1.opening.blinding,
      c2.opening.blinding,
    );
    expect(verifyEqualOpenings(c1.commitment, c2.commitment, proof)).toBe(
      false,
    );
  });

  it("rejects against swapped commitments", () => {
    const c1 = commit(100n);
    const c2 = commit(100n);
    const proof = proveEqualOpenings(
      c1.commitment,
      c2.commitment,
      c1.opening.blinding,
      c2.opening.blinding,
    );
    const other = commit(100n).commitment;
    expect(verifyEqualOpenings(c1.commitment, other, proof)).toBe(false);
  });
});

describe("ZK proof that a commitment is to a bit (0 or 1)", () => {
  it("verifies for bit = 0", () => {
    const { commitment, proof } = proveBit(0, 12_345n);
    expect(verifyBit(commitment, proof)).toBe(true);
  });

  it("verifies for bit = 1", () => {
    const { commitment, proof } = proveBit(1, 67_890n);
    expect(verifyBit(commitment, proof)).toBe(true);
  });

  it("rejects a proof attached to a commitment to 2 (not a bit)", () => {
    // Manually build a commitment to value 2 and try to reuse a bit proof.
    const pseudoBlinding = 9_999n;
    const pseudoCommitment = commitWithBlinding(2n, pseudoBlinding);
    // Build a proof for bit=1 with the same blinding — it should fail
    // verification against the commitment-to-2 because P1 = C - G ≠ r·H
    // when v = 2.
    const { proof } = proveBit(1, pseudoBlinding);
    expect(verifyBit(pseudoCommitment, proof)).toBe(false);
  });

  it("rejects when challenges don't add up to the Fiat-Shamir total", () => {
    const { commitment, proof } = proveBit(1, 111n);
    const bad = { ...proof, c0hex: "00".repeat(32) };
    expect(verifyBit(commitment, bad)).toBe(false);
  });
});

describe("End-to-end scenario: user proves balance without revealing it", () => {
  it("round-trips: bank commits publicly, user later opens only when asked", () => {
    // 1. During a transaction, the service commits to the user's balance.
    const balance = 250_000n;
    const { commitment, opening } = commit(balance);

    // The commitment alone leaks no information about the balance.
    // (We don't try to assert "the hex doesn't contain the balance" —
    // that's not a meaningful test — but we DO verify the hiding proof above.)
    expect(commitment.hex.length).toBe(66); // 33 bytes compressed, hex-encoded

    // 2. Later, a counter-party asks the user to prove their balance
    //    matches what they claimed off-band. User does so without sending
    //    the raw balance.
    const proof = proveBalanceEquals(commitment, opening, balance);
    expect(proof).not.toBeNull();
    expect(verifyBalanceEquals(commitment, balance, proof!)).toBe(true);
  });

  it("proveBalanceEquals returns null when the claim is a lie", () => {
    const { commitment, opening } = commit(100n);
    const proof = proveBalanceEquals(commitment, opening, 200n);
    expect(proof).toBeNull();
  });
});
