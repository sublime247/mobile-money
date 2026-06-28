import elliptic from "elliptic";
import { createHash } from "crypto";
import {
  DEFAULT_PARAMS,
  ZkParams,
  Commitment,
  Opening,
  proveBit,
  verifyBit,
  verifyOpening,
  proveOpening,
  commitWithBlinding,
} from "./zkBalanceProof";

const ec = new elliptic.ec("secp256k1");
const ORDER = ec.curve.n;
const BN = ORDER.constructor as any;

export interface RangeProof {
  bitCommitments: string[]; // hex commitments
  bitProofs: any[];         // BitProof objects
}

/**
 * Generate a ZK Range Proof that the committed value v satisfies: v >= threshold
 * We decompose delta = v - threshold into k bits.
 * For age >= 18, threshold is 18. Since age is generally < 256, k = 8 bits is sufficient.
 */
export function proveRange(
  commitment: Commitment,
  opening: Opening,
  threshold: bigint,
  k = 8,
  params: ZkParams = DEFAULT_PARAMS
): RangeProof {
  const value = opening.value;
  if (value < threshold) {
    throw new Error("Value is less than threshold, cannot prove range");
  }

  const delta = value - threshold;
  const r = new BN(opening.blinding.toString(16), 16);

  // Decompose delta into bits
  const bits: number[] = [];
  let temp = delta;
  for (let i = 0; i < k; i++) {
    bits.push(Number(temp & 1n));
    temp >>= 1n;
  }

  // Generate random blindings for the first k-1 bits
  const rBits: any[] = [];
  let sumR = new BN(0);
  const two = new BN(2);

  for (let i = 0; i < k - 1; i++) {
    // Generate random scalar
    const ri = ec.genKeyPair().getPrivate();
    rBits.push(ri);
    
    // sumR = sumR + ri * 2^i mod ORDER
    const factor = two.pow(new BN(i));
    sumR = sumR.add(ri.mul(factor)).umod(ORDER);
  }

  // Solve for the last blinding factor r_{k-1} such that:
  // r = sum_{i=0}^{k-1} 2^i * r_i mod ORDER
  // r_{k-1} = (r - sumR) * (2^(k-1))^-1 mod ORDER
  const inv2k = two.pow(new BN(k - 1)).invm(ORDER);
  const rLast = r.sub(sumR).mul(inv2k).umod(ORDER);
  rBits.push(rLast);

  const bitCommitments: string[] = [];
  const bitProofs: any[] = [];

  for (let i = 0; i < k; i++) {
    const { commitment: bitCommit, proof: bitPrf } = proveBit(
      bits[i],
      BigInt("0x" + rBits[i].toString(16)),
      params
    );
    bitCommitments.push(bitCommit.hex);
    bitProofs.push(bitPrf);
  }

  return {
    bitCommitments,
    bitProofs,
  };
}

/**
 * Verify a ZK Range Proof that the committed value v satisfies: v >= threshold
 */
export function verifyRange(
  commitment: Commitment,
  proof: RangeProof,
  threshold: bigint,
  k = 8,
  params: ZkParams = DEFAULT_PARAMS
): boolean {
  try {
    if (proof.bitCommitments.length !== k || proof.bitProofs.length !== k) {
      return false;
    }

    const bitCommitments: Commitment[] = [];
    for (const hex of proof.bitCommitments) {
      const point = ec.curve.decodePoint(Buffer.from(hex, "hex"));
      bitCommitments.push({ point, hex });
    }

    // Verify each bit commitment is indeed 0 or 1
    for (let i = 0; i < k; i++) {
      const isValid = verifyBit(bitCommitments[i], proof.bitProofs[i], params);
      if (!isValid) return false;
    }

    // Compute C_sum = sum_{i=0}^{k-1} 2^i * C_i
    let sumPoint = ec.curve.point(null, null); // Infinity point
    const two = new BN(2);

    for (let i = 0; i < k; i++) {
      const factor = two.pow(new BN(i));
      const term = bitCommitments[i].point.mul(factor);
      sumPoint = sumPoint.add(term);
    }

    // Compute C_delta = C - threshold * G
    // threshold * G
    const threshScalar = new BN(threshold.toString());
    const threshPoint = params.G.mul(threshScalar);
    const expectedDeltaPoint = commitment.point.add(threshPoint.neg());

    // Check if C_sum == C_delta
    return sumPoint.eq(expectedDeltaPoint);
  } catch (error) {
    return false;
  }
}

// ── Authority Signatures on Commitments ──────────────────────────────────────

/**
 * Sign a Pedersen commitment hex along with the attribute type (e.g. "age")
 */
export function signCommitment(
  privateKeyHex: string,
  commitmentHex: string,
  attributeType: string
): string {
  const key = ec.keyFromPrivate(privateKeyHex, "hex");
  const msg = `${commitmentHex}:${attributeType}`;
  const msgHash = createHash("sha256").update(msg).digest();
  const signature = key.sign(msgHash);
  return signature.toDER("hex");
}

/**
 * Verify the authority's signature on a commitment hex and attribute type
 */
export function verifyCommitmentSignature(
  publicKeyHex: string,
  commitmentHex: string,
  attributeType: string,
  signatureHex: string
): boolean {
  try {
    const key = ec.keyFromPublic(publicKeyHex, "hex");
    const msg = `${commitmentHex}:${attributeType}`;
    const msgHash = createHash("sha256").update(msg).digest();
    return key.verify(msgHash, signatureHex);
  } catch {
    return false;
  }
}
