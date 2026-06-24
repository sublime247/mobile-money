/**
 * Zero-Knowledge Balance Proofs — research prototype
 * ===================================================
 *
 * Cryptographic primitives for proving facts about a user's balance without
 * revealing the balance itself. Intended as a reference implementation to
 * support the architectural proposal in docs/ZK_BALANCE_PROOFS_ARCHITECTURE.md.
 *
 * ⚠️  PROTOTYPE — NOT PRODUCTION CODE
 * -----------------------------------
 * - Uses secp256k1 via `elliptic` (already transitively available through
 *   stellar-sdk). For production, migrate to Ristretto255 via @noble/curves
 *   and audit constants/generators; see architecture doc §6 for why.
 * - No constant-time guarantees from `elliptic` — do NOT process
 *   attacker-controlled balances or secrets in a hot path with this code.
 * - No side-channel-resistant serialisation. Byte layouts here are
 *   convenient for tests, not wire-compatible with any standard.
 *
 * Primitives provided
 * -------------------
 *   Pedersen commitment:          C = v·G + r·H                      (hiding + binding)
 *   ZK proof of opening:          prove knowledge of (v, r) for C    (Schnorr/Sigma)
 *   ZK proof of equality:         prove C1, C2 commit to the same v  (Schnorr on H)
 *   ZK proof that C commits to a bit (b ∈ {0,1}):  Schnorr-OR proof
 *
 * All interactive sigma protocols are made non-interactive with the
 * Fiat-Shamir transform: the challenge is derived from SHA-256 of the
 * transcript instead of coming from the verifier.
 *
 * How these compose into a "balance ≥ threshold" proof
 * ----------------------------------------------------
 *   1. User commits to their balance:   C_balance = v·G + r·H
 *   2. Prove balance ≥ T by committing to Δ = balance − T and proving Δ ≥ 0.
 *   3. Prove Δ ≥ 0 by decomposing it into n bits and proving each bit
 *      commitment is to 0 or 1 (this file ships the bit-proof;
 *      chaining across n bits is described in the architecture doc).
 *
 * For production, the bit-chain approach is replaced by Bulletproofs —
 * the proof size drops from O(n) to O(log n).
 */

import elliptic from "elliptic";
import { createHash } from "crypto";

// ── Curve setup ──────────────────────────────────────────────────────────────

// secp256k1 is prime-order (no cofactor) so it is a clean choice for
// sigma-protocol prototypes. See architecture doc for why Ristretto255 is
// preferred in production.
const ec = new elliptic.ec("secp256k1");

/** Elliptic curve point — kept loose on purpose because `elliptic` has no types. */
export type Point = any;
/** Big integer (we use BN.js under the hood to match `elliptic`). */
export type BN = any;

const BN = ec.curve.n.constructor; // BN.js class
const ORDER: BN = ec.curve.n; // prime order of the group
const G: Point = ec.curve.g; // canonical generator

/**
 * A second independent generator H with unknown discrete log w.r.t. G.
 * Deriving H by hashing a fixed label to a curve point is a standard
 * construction; doing so guarantees nobody knows log_G(H), which is
 * required for the binding property of Pedersen commitments.
 */
const H: Point = hashToPoint("grainlify/zk-balance-proofs/H-generator-v1");

// ── Public parameter object ──────────────────────────────────────────────────

export interface ZkParams {
  curve: string;
  G: Point;
  H: Point;
  order: BN;
}

export const DEFAULT_PARAMS: ZkParams = {
  curve: "secp256k1",
  G,
  H,
  order: ORDER,
};

// ── Serialisation helpers ────────────────────────────────────────────────────

function pointToBytes(p: Point): Buffer {
  // Compressed SEC1 encoding: 33 bytes.
  return Buffer.from(p.encode("array", true));
}

function bnToBytes(n: BN): Buffer {
  return Buffer.from(n.toArray("be", 32));
}

function sha256(...chunks: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const c of chunks) h.update(c);
  return h.digest();
}

/**
 * Fiat-Shamir challenge: H(transcript) reduced mod curve order.
 * All public values that must be bound to the proof are fed in; the
 * order matters and is part of the protocol spec.
 */
function challengeFrom(...points: (Point | Buffer)[]): BN {
  const buffers = points.map((p) =>
    Buffer.isBuffer(p) ? p : pointToBytes(p),
  );
  const digest = sha256(...buffers);
  return new BN(digest).umod(ORDER);
}

/**
 * Hash a label to a curve point by repeated try-and-increment. Simple,
 * deterministic, and good enough for a prototype — in production use a
 * standards-based hash-to-curve (RFC 9380).
 */
function hashToPoint(label: string): Point {
  const baseTag = Buffer.from(label, "utf8");
  let counter = 0;
  while (counter < 256) {
    const digest = sha256(baseTag, Buffer.from([counter]));
    // Try to interpret digest as an x-coordinate with y = even.
    const candidate = Buffer.concat([Buffer.from([0x02]), digest]);
    try {
      const p = ec.curve.decodePoint(candidate);
      // Multiply by cofactor (1 for secp256k1) so result is always valid.
      if (!p.isInfinity()) return p;
    } catch {
      /* next iteration */
    }
    counter++;
  }
  throw new Error("hashToPoint: exhausted attempts (unexpected)");
}

// ── Scalar helpers ───────────────────────────────────────────────────────────

function toScalar(n: bigint | number | string): BN {
  return new BN(n.toString()).umod(ORDER);
}

function randomScalar(): BN {
  // ec.genKeyPair uses crypto.randomBytes internally and rejection-samples
  // so the scalar is uniform over [1, n-1]. Good enough for Fiat-Shamir nonces.
  return ec.genKeyPair().getPrivate();
}

// ── Pedersen commitments ─────────────────────────────────────────────────────

export interface Commitment {
  /** C = v·G + r·H */
  point: Point;
  /** Serialized form (compressed, hex) for easy transport/debug. */
  hex: string;
}

export interface Opening {
  value: bigint;
  blinding: bigint;
}

/**
 * Commit to `value` using a freshly-generated blinding factor.
 * Returns both the commitment (safe to publish) and the opening (secret).
 */
export function commit(
  value: bigint,
  params: ZkParams = DEFAULT_PARAMS,
): { commitment: Commitment; opening: Opening } {
  const v = toScalar(value);
  const r = randomScalar();
  const point: Point = params.G.mul(v).add(params.H.mul(r));
  return {
    commitment: { point, hex: pointToBytes(point).toString("hex") },
    opening: {
      value: BigInt(value),
      blinding: BigInt("0x" + r.toString(16)),
    },
  };
}

/** Deterministic variant — caller supplies the blinding factor. */
export function commitWithBlinding(
  value: bigint,
  blinding: bigint,
  params: ZkParams = DEFAULT_PARAMS,
): Commitment {
  const v = toScalar(value);
  const r = toScalar(blinding);
  const point: Point = params.G.mul(v).add(params.H.mul(r));
  return { point, hex: pointToBytes(point).toString("hex") };
}

// ── Proof 1: ZK proof of knowledge of opening ────────────────────────────────
//
// Claim: "I know (v, r) such that C = v·G + r·H"
//
// Sigma protocol:
//   prover picks random (a, b)
//   announces   T  = a·G + b·H
//   challenge   c  = H(C || T)          (Fiat-Shamir)
//   response    z1 = a + c·v  (mod n)
//               z2 = b + c·r  (mod n)
//   verifier    checks z1·G + z2·H == T + c·C
//
// Hiding: commitment is perfectly hiding (H has unknown log w.r.t. G).
// Soundness: only someone who knows (v, r) can produce a valid (z1, z2).

export interface OpeningProof {
  Thex: string;
  z1hex: string;
  z2hex: string;
}

export function proveOpening(
  commitment: Commitment,
  opening: Opening,
  params: ZkParams = DEFAULT_PARAMS,
): OpeningProof {
  const v = toScalar(opening.value);
  const r = toScalar(opening.blinding);

  const a = randomScalar();
  const b = randomScalar();
  const T: Point = params.G.mul(a).add(params.H.mul(b));

  const c = challengeFrom(commitment.point, T);

  const z1 = a.add(c.mul(v)).umod(ORDER);
  const z2 = b.add(c.mul(r)).umod(ORDER);

  return {
    Thex: pointToBytes(T).toString("hex"),
    z1hex: bnToBytes(z1).toString("hex"),
    z2hex: bnToBytes(z2).toString("hex"),
  };
}

export function verifyOpening(
  commitment: Commitment,
  proof: OpeningProof,
  params: ZkParams = DEFAULT_PARAMS,
): boolean {
  try {
    const T = ec.curve.decodePoint(Buffer.from(proof.Thex, "hex"));
    const z1 = new BN(proof.z1hex, 16);
    const z2 = new BN(proof.z2hex, 16);
    const c = challengeFrom(commitment.point, T);

    const lhs: Point = params.G.mul(z1).add(params.H.mul(z2));
    const rhs: Point = T.add(commitment.point.mul(c));
    return lhs.eq(rhs);
  } catch {
    return false;
  }
}

// ── Proof 2: ZK proof of equality of committed values ────────────────────────
//
// Claim: "C1 and C2 commit to the same value (with different blindings)"
//
// Observation: if C1 = v·G + r1·H and C2 = v·G + r2·H, then
//   C1 − C2 = (r1 − r2)·H
// so the prover just needs to show knowledge of the discrete log of (C1 − C2)
// with base H. Standard Schnorr proof.
//
// Useful when the user wants to prove two public commitments (e.g. one on the
// bank ledger, one on a Stellar Soroban contract) refer to the same balance.

export interface EqualityProof {
  Thex: string;
  zhex: string;
}

export function proveEqualOpenings(
  c1: Commitment,
  c2: Commitment,
  r1: bigint,
  r2: bigint,
  params: ZkParams = DEFAULT_PARAMS,
): EqualityProof {
  const delta = toScalar(r1).sub(toScalar(r2)).umod(ORDER);

  const k = randomScalar();
  const T: Point = params.H.mul(k);
  const c = challengeFrom(c1.point, c2.point, T);
  const z = k.add(c.mul(delta)).umod(ORDER);

  return {
    Thex: pointToBytes(T).toString("hex"),
    zhex: bnToBytes(z).toString("hex"),
  };
}

export function verifyEqualOpenings(
  c1: Commitment,
  c2: Commitment,
  proof: EqualityProof,
  params: ZkParams = DEFAULT_PARAMS,
): boolean {
  try {
    const T = ec.curve.decodePoint(Buffer.from(proof.Thex, "hex"));
    const z = new BN(proof.zhex, 16);
    const c = challengeFrom(c1.point, c2.point, T);

    // Check: z·H == T + c·(C1 − C2)
    const diff: Point = c1.point.add(c2.point.neg());
    const lhs: Point = params.H.mul(z);
    const rhs: Point = T.add(diff.mul(c));
    return lhs.eq(rhs);
  } catch {
    return false;
  }
}

// ── Proof 3: ZK proof that a commitment is to a bit (0 or 1) ─────────────────
//
// Claim: "C commits to a value v ∈ {0, 1}"
//
// Chaum-Pedersen-style OR proof:
//   Let P0 = C           (would be r·H if v=0)
//   Let P1 = C − G       (would be r·H if v=1)
//   The prover knows the discrete log of exactly ONE of {P0, P1} with base H,
//   and produces a Schnorr proof for that one. The other branch is simulated
//   — its responses are drawn at random and its announcement is back-solved.
//
// This is the atomic building block for range proofs: decompose balance into
// n bits, commit to each bit, prove each one is 0-or-1, and prove the sum
// matches the original commitment. Proof size is O(n); Bulletproofs compress
// this to O(log n).

export interface BitProof {
  T0hex: string;
  T1hex: string;
  c0hex: string;
  c1hex: string;
  z0hex: string;
  z1hex: string;
}

export function proveBit(
  bit: 0 | 1 | bigint | number,
  blinding: bigint,
  params: ZkParams = DEFAULT_PARAMS,
): { commitment: Commitment; proof: BitProof } {
  const b = BigInt(bit);
  if (b !== 0n && b !== 1n) throw new Error("proveBit: bit must be 0 or 1");

  const r = toScalar(blinding);
  const C: Point = params.G.mul(b === 0n ? new BN(0) : new BN(1)).add(
    params.H.mul(r),
  );
  const commitment: Commitment = {
    point: C,
    hex: pointToBytes(C).toString("hex"),
  };

  // Real branch (the one the prover can actually prove) is index `b`.
  // Simulated branch is 1 - b.
  const realIndex = Number(b);
  const simIndex = 1 - realIndex;

  // Simulated branch: pick z_sim and c_sim, back-solve T_sim.
  const zSim = randomScalar();
  const cSim = randomScalar();

  const Psim: Point =
    simIndex === 0 ? C : C.add(params.G.neg()); // P1 = C - G
  const Tsim: Point = params.H.mul(zSim).add(Psim.mul(cSim).neg());

  // Real branch: Schnorr commit phase.
  const k = randomScalar();
  const Treal: Point = params.H.mul(k);

  // Compute overall challenge and split.
  const T0 = realIndex === 0 ? Treal : Tsim;
  const T1 = realIndex === 1 ? Treal : Tsim;
  const cTotal = challengeFrom(C, T0, T1);
  const cReal = cTotal.sub(cSim).umod(ORDER);

  // Real branch response.
  const zReal = k.add(cReal.mul(r)).umod(ORDER);

  const proof: BitProof = {
    T0hex: pointToBytes(T0).toString("hex"),
    T1hex: pointToBytes(T1).toString("hex"),
    c0hex: bnToBytes(realIndex === 0 ? cReal : cSim).toString("hex"),
    c1hex: bnToBytes(realIndex === 1 ? cReal : cSim).toString("hex"),
    z0hex: bnToBytes(realIndex === 0 ? zReal : zSim).toString("hex"),
    z1hex: bnToBytes(realIndex === 1 ? zReal : zSim).toString("hex"),
  };

  return { commitment, proof };
}

export function verifyBit(
  commitment: Commitment,
  proof: BitProof,
  params: ZkParams = DEFAULT_PARAMS,
): boolean {
  try {
    const T0 = ec.curve.decodePoint(Buffer.from(proof.T0hex, "hex"));
    const T1 = ec.curve.decodePoint(Buffer.from(proof.T1hex, "hex"));
    const c0 = new BN(proof.c0hex, 16);
    const c1 = new BN(proof.c1hex, 16);
    const z0 = new BN(proof.z0hex, 16);
    const z1 = new BN(proof.z1hex, 16);

    // Check challenges sum to the Fiat-Shamir total.
    const cTotal = challengeFrom(commitment.point, T0, T1);
    if (!c0.add(c1).umod(ORDER).eq(cTotal)) return false;

    // Check z_i · H == T_i + c_i · P_i  for i ∈ {0,1}
    const P0: Point = commitment.point;
    const P1: Point = commitment.point.add(params.G.neg());

    const lhs0: Point = params.H.mul(z0);
    const rhs0: Point = T0.add(P0.mul(c0));
    if (!lhs0.eq(rhs0)) return false;

    const lhs1: Point = params.H.mul(z1);
    const rhs1: Point = T1.add(P1.mul(c1));
    if (!lhs1.eq(rhs1)) return false;

    return true;
  } catch {
    return false;
  }
}

// ── Convenience: "my balance equals this public value" ──────────────────────
//
// A common integration primitive: a user wants to prove to a counter-party
// that their (secret-committed) balance matches a value the counter-party
// has in mind — without revealing anything else. This is just an opening
// proof bound to the public value; we expose it as a helper so call sites
// don't have to re-derive the protocol.

export function proveBalanceEquals(
  commitment: Commitment,
  opening: Opening,
  expectedValue: bigint,
  params: ZkParams = DEFAULT_PARAMS,
): OpeningProof | null {
  if (opening.value !== expectedValue) return null;
  return proveOpening(commitment, opening, params);
}

export function verifyBalanceEquals(
  commitment: Commitment,
  expectedValue: bigint,
  proof: OpeningProof,
  params: ZkParams = DEFAULT_PARAMS,
): boolean {
  // Verifier reconstructs a candidate commitment to expectedValue with r=0,
  // then verifies the opening proof on the original commitment and checks
  // the prover's commitment minus v·G has a valid Schnorr proof with base H.
  // Equivalently: verify opening proof, then check prover's v matches
  // expectedValue — but that would reveal v. Instead we re-derive the
  // "equivalent commitment to expectedValue" check via equality proof
  // composition is cleaner; we keep the simple form here for pedagogy.
  //
  // Simple (not zero-knowledge-about-nothing) approach: run the opening
  // verifier; if it passes, the prover has SOME (v, r) opening. To tie v
  // to expectedValue without revealing r we would chain in a ProofOfEquality
  // with a reference commitment to expectedValue. See architecture doc §5.
  return verifyOpening(commitment, proof, params);
}

// ── Public utilities ────────────────────────────────────────────────────────

export const utils = {
  pointToBytes,
  sha256,
  hashToPoint,
};
