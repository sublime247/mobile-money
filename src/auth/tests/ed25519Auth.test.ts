/**
 * Ed25519 request signature auth tests — issue #2462
 */

import { generateKeyPairSync } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  verifyEd25519Signature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "../ed25519SignatureAuth";
import {
  buildCanonicalRequest,
  validateTimestamp,
  sha256Hex,
  MAX_CLOCK_SKEW_SECONDS,
} from "../../utils/canonicalRequest";

// ---------------------------------------------------------------------------
// Key generation helpers
// ---------------------------------------------------------------------------

function makePemKeypair() {
  return generateKeyPairSync("ed25519");
}

function signWithPem(message: string, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]): string {
  const { sign } = require("crypto");
  return sign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");
}

function makeStellarKeypair() {
  return Keypair.random();
}

// ---------------------------------------------------------------------------
// canonicalRequest helpers
// ---------------------------------------------------------------------------

describe("buildCanonicalRequest", () => {
  it("produces deterministic output for the same inputs", () => {
    const opts = {
      method: "POST",
      path: "/api/v1/transactions",
      timestamp: "1729334400",
      body: '{"amount":100}',
    };
    expect(buildCanonicalRequest(opts)).toBe(buildCanonicalRequest(opts));
  });

  it("uppercases the HTTP method", () => {
    const canonical = buildCanonicalRequest({
      method: "post",
      path: "/api/v1/transactions",
      timestamp: "1729334400",
    });
    expect(canonical.startsWith("POST\n")).toBe(true);
  });

  it("lowercases the path", () => {
    const canonical = buildCanonicalRequest({
      method: "GET",
      path: "/API/V1/TRANSACTIONS",
      timestamp: "1729334400",
    });
    expect(canonical.split("\n")[1]).toBe("/api/v1/transactions");
  });

  it("includes sha256 of empty string when body is absent", () => {
    const canonical = buildCanonicalRequest({
      method: "GET",
      path: "/health",
      timestamp: "1729334400",
    });
    const emptyDigest = sha256Hex("");
    expect(canonical.endsWith(emptyDigest)).toBe(true);
  });

  it("changes output when body changes", () => {
    const base = {
      method: "POST",
      path: "/api/v1/transactions",
      timestamp: "1729334400",
    };
    const c1 = buildCanonicalRequest({ ...base, body: "body-a" });
    const c2 = buildCanonicalRequest({ ...base, body: "body-b" });
    expect(c1).not.toBe(c2);
  });

  it("changes output when path changes (tamper detection)", () => {
    const base = { method: "POST", timestamp: "1729334400", body: "x" };
    const c1 = buildCanonicalRequest({ ...base, path: "/api/v1/quotes" });
    const c2 = buildCanonicalRequest({ ...base, path: "/api/v1/transactions" });
    expect(c1).not.toBe(c2);
  });
});

// ---------------------------------------------------------------------------
// validateTimestamp
// ---------------------------------------------------------------------------

describe("validateTimestamp", () => {
  it("accepts a fresh timestamp", () => {
    const now = Math.floor(Date.now() / 1000);
    const { valid } = validateTimestamp(String(now), now);
    expect(valid).toBe(true);
  });

  it("rejects a timestamp older than MAX_CLOCK_SKEW_SECONDS", () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = now - MAX_CLOCK_SKEW_SECONDS - 1;
    const { valid } = validateTimestamp(String(stale), now);
    expect(valid).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    const { valid } = validateTimestamp("not-a-number");
    expect(valid).toBe(false);
  });

  it("rejects an empty timestamp", () => {
    const { valid } = validateTimestamp("");
    expect(valid).toBe(false);
  });

  it("accepts a timestamp in the future within skew window", () => {
    const now = Math.floor(Date.now() / 1000);
    const future = now + MAX_CLOCK_SKEW_SECONDS - 1;
    const { valid } = validateTimestamp(String(future), now);
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyEd25519Signature — Stellar keypair
// ---------------------------------------------------------------------------

describe("verifyEd25519Signature — Stellar G-address", () => {
  it("verifies a valid signature", () => {
    const kp = makeStellarKeypair();
    const message = "POST\n/api/v1/transactions\n1729334400\nabc123";
    const sig = kp.sign(Buffer.from(message, "utf8")).toString("hex");

    const result = verifyEd25519Signature(message, sig, kp.publicKey());
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered message", () => {
    const kp = makeStellarKeypair();
    const original = "POST\n/api/v1/transactions\n1729334400\nabc123";
    const tampered = "POST\n/api/v1/admin\n1729334400\nabc123";
    const sig = kp.sign(Buffer.from(original, "utf8")).toString("hex");

    const result = verifyEd25519Signature(tampered, sig, kp.publicKey());
    expect(result.valid).toBe(false);
  });

  it("rejects a signature made by a different key", () => {
    const kp1 = makeStellarKeypair();
    const kp2 = makeStellarKeypair();
    const message = "POST\n/api/v1/transactions\n1729334400\nabc123";
    const sig = kp1.sign(Buffer.from(message, "utf8")).toString("hex");

    const result = verifyEd25519Signature(message, sig, kp2.publicKey());
    expect(result.valid).toBe(false);
  });

  it("rejects a malformed signature hex string", () => {
    const kp = makeStellarKeypair();
    const message = "GET\n/health\n1729334400\nabc";
    const result = verifyEd25519Signature(message, "not-hex!!!", kp.publicKey());
    expect(result.valid).toBe(false);
  });

  it("rejects an invalid public key", () => {
    const kp = makeStellarKeypair();
    const message = "GET\n/health\n1729334400\nabc";
    const sig = kp.sign(Buffer.from(message, "utf8")).toString("hex");
    const result = verifyEd25519Signature(message, sig, "INVALID_KEY");
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyEd25519Signature — PEM keypair
// ---------------------------------------------------------------------------

describe("verifyEd25519Signature — PEM Ed25519 key", () => {
  it("verifies a valid PEM-signed request", () => {
    const { privateKey, publicKey } = makePemKeypair();
    const message = "DELETE\n/api/v1/vaults/abc\n1729334400\n";
    const sig = signWithPem(message, privateKey);
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    const result = verifyEd25519Signature(message, sig, pubPem);
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered body hash", () => {
    const { privateKey, publicKey } = makePemKeypair();
    const original = "POST\n/api/v1/transactions\n1729334400\nhash-original";
    const tampered = "POST\n/api/v1/transactions\n1729334400\nhash-tampered";
    const sig = signWithPem(original, privateKey);
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    const result = verifyEd25519Signature(tampered, sig, pubPem);
    expect(result.valid).toBe(false);
  });
});
