import { commit, DEFAULT_PARAMS, verifyOpening, proveOpening, proveBalanceEquals, verifyBalanceEquals } from "../../src/crypto/zkBalanceProof";
import {
  proveRange,
  verifyRange,
  signCommitment,
  verifyCommitmentSignature,
} from "../../src/crypto/zkKycProof";

describe("ZK KYC Range Proof (age >= 18)", () => {
  it("proves and verifies that age 20 is >= 18", () => {
    const age = 20n;
    const threshold = 18n;
    const { commitment, opening } = commit(age);

    const proof = proveRange(commitment, opening, threshold, 8);
    const isValid = verifyRange(commitment, proof, threshold, 8);
    expect(isValid).toBe(true);
  });

  it("proves and verifies that age 18 is >= 18", () => {
    const age = 18n;
    const threshold = 18n;
    const { commitment, opening } = commit(age);

    const proof = proveRange(commitment, opening, threshold, 8);
    const isValid = verifyRange(commitment, proof, threshold, 8);
    expect(isValid).toBe(true);
  });

  it("fails to prove that age 17 is >= 18", () => {
    const age = 17n;
    const threshold = 18n;
    const { commitment, opening } = commit(age);

    expect(() => {
      proveRange(commitment, opening, threshold, 8);
    }).toThrow();
  });

  it("rejects range proof if bit commitments are tampered", () => {
    const age = 25n;
    const threshold = 18n;
    const { commitment, opening } = commit(age);

    const proof = proveRange(commitment, opening, threshold, 8);
    // Tamper with the first bit commitment
    const tamperedCommitments = [...proof.bitCommitments];
    tamperedCommitments[0] = "00".repeat(33); // invalid point
    const badProof = { ...proof, bitCommitments: tamperedCommitments };

    const isValid = verifyRange(commitment, badProof, threshold, 8);
    expect(isValid).toBe(false);
  });
});

import elliptic from "elliptic";

describe("KYC Authority Signatures", () => {
  const ec = new elliptic.ec("secp256k1");
  const keyPair = ec.genKeyPair();
  const privateKey = keyPair.getPrivate("hex");
  const publicKey = keyPair.getPublic("hex");

  it("signs and verifies a commitment signature successfully", () => {
    const { commitment } = commit(20n);
    const attributeType = "age";

    const signature = signCommitment(privateKey, commitment.hex, attributeType);
    const isValid = verifyCommitmentSignature(publicKey, commitment.hex, attributeType, signature);
    expect(isValid).toBe(true);
  });

  it("fails validation on tampered signature", () => {
    const { commitment } = commit(20n);
    const attributeType = "age";

    const signature = signCommitment(privateKey, commitment.hex, attributeType);
    const badSignature = signature.replace(/^[0-9a-f]{2}/, "00");

    const isValid = verifyCommitmentSignature(publicKey, commitment.hex, attributeType, badSignature);
    expect(isValid).toBe(false);
  });

  it("fails validation on tampered commitment hex", () => {
    const { commitment } = commit(20n);
    const { commitment: otherCommitment } = commit(20n);
    const attributeType = "age";

    const signature = signCommitment(privateKey, commitment.hex, attributeType);
    const isValid = verifyCommitmentSignature(publicKey, otherCommitment.hex, attributeType, signature);
    expect(isValid).toBe(false);
  });
});
