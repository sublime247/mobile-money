/**
 * Signed URL generator / validator tests — issue #2461
 */

// Use a deterministic secret for all tests
process.env.SIGNED_URL_SECRET = "test-signed-url-secret-do-not-use-in-prod";

import {
  generateSignedUrlParams,
  buildSignedUrl,
  validateSignedUrl,
  DEFAULT_TTL_SECONDS,
} from "../../utils/signedUrl";

const DOC_ID = "kyc-doc-001";
const CUST_ID = "user-123";

// ---------------------------------------------------------------------------
// generateSignedUrlParams
// ---------------------------------------------------------------------------

describe("generateSignedUrlParams", () => {
  it("returns doc, cid, exp, sig fields", () => {
    const params = generateSignedUrlParams({ documentId: DOC_ID, customerId: CUST_ID });
    expect(params.doc).toBe(DOC_ID);
    expect(params.cid).toBe(CUST_ID);
    expect(params.exp).toMatch(/^\d+$/);
    expect(params.sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets expiry to now + DEFAULT_TTL_SECONDS by default", () => {
    const before = Math.floor(Date.now() / 1000);
    const { exp } = generateSignedUrlParams({ documentId: DOC_ID, customerId: CUST_ID });
    const after = Math.floor(Date.now() / 1000);
    const expNum = parseInt(exp, 10);
    expect(expNum).toBeGreaterThanOrEqual(before + DEFAULT_TTL_SECONDS);
    expect(expNum).toBeLessThanOrEqual(after + DEFAULT_TTL_SECONDS);
  });

  it("respects a custom expiresAt", () => {
    const customExpiry = Math.floor(Date.now() / 1000) + 3600;
    const { exp } = generateSignedUrlParams({
      documentId: DOC_ID,
      customerId: CUST_ID,
      expiresAt: customExpiry,
    });
    expect(parseInt(exp, 10)).toBe(customExpiry);
  });

  it("produces different signatures for different document IDs", () => {
    const p1 = generateSignedUrlParams({ documentId: "doc-a", customerId: CUST_ID });
    const p2 = generateSignedUrlParams({ documentId: "doc-b", customerId: CUST_ID });
    expect(p1.sig).not.toBe(p2.sig);
  });

  it("produces different signatures for different customer IDs", () => {
    const p1 = generateSignedUrlParams({ documentId: DOC_ID, customerId: "u-1" });
    const p2 = generateSignedUrlParams({ documentId: DOC_ID, customerId: "u-2" });
    expect(p1.sig).not.toBe(p2.sig);
  });

  it("throws when documentId is empty", () => {
    expect(() =>
      generateSignedUrlParams({ documentId: "", customerId: CUST_ID }),
    ).toThrow(/documentId/);
  });

  it("throws when customerId is empty", () => {
    expect(() =>
      generateSignedUrlParams({ documentId: DOC_ID, customerId: "" }),
    ).toThrow(/customerId/);
  });
});

// ---------------------------------------------------------------------------
// buildSignedUrl
// ---------------------------------------------------------------------------

describe("buildSignedUrl", () => {
  it("appends all params to the base URL", () => {
    const url = buildSignedUrl("/docs/download", { documentId: DOC_ID, customerId: CUST_ID });
    expect(url).toContain("/docs/download?");
    expect(url).toContain("doc=");
    expect(url).toContain("cid=");
    expect(url).toContain("exp=");
    expect(url).toContain("sig=");
  });

  it("uses & separator when base URL already has query params", () => {
    const url = buildSignedUrl("/docs/download?format=pdf", {
      documentId: DOC_ID,
      customerId: CUST_ID,
    });
    expect(url).toContain("format=pdf&");
  });
});

// ---------------------------------------------------------------------------
// validateSignedUrl
// ---------------------------------------------------------------------------

describe("validateSignedUrl — valid URLs", () => {
  it("validates a freshly generated URL", () => {
    const params = generateSignedUrlParams({ documentId: DOC_ID, customerId: CUST_ID });
    const result = validateSignedUrl(params);
    expect(result.valid).toBe(true);
    expect(result.documentId).toBe(DOC_ID);
    expect(result.customerId).toBe(CUST_ID);
  });

  it("returns documentId and customerId on success", () => {
    const params = generateSignedUrlParams({ documentId: "doc-xyz", customerId: "user-abc" });
    const result = validateSignedUrl(params);
    expect(result.documentId).toBe("doc-xyz");
    expect(result.customerId).toBe("user-abc");
  });
});

describe("validateSignedUrl — expired URLs", () => {
  it("rejects an expired URL", () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    const params = generateSignedUrlParams({
      documentId: DOC_ID,
      customerId: CUST_ID,
      expiresAt: past,
    });
    const result = validateSignedUrl(params);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/i);
  });
});

describe("validateSignedUrl — tampered parameters", () => {
  it("rejects when doc is changed", () => {
    const params = generateSignedUrlParams({ documentId: DOC_ID, customerId: CUST_ID });
    const result = validateSignedUrl({ ...params, doc: "tampered-doc" });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid signature/i);
  });

  it("rejects when cid is changed", () => {
    const params = generateSignedUrlParams({ documentId: DOC_ID, customerId: CUST_ID });
    const result = validateSignedUrl({ ...params, cid: "tampered-user" });
    expect(result.valid).toBe(false);
  });

  it("rejects when exp is changed", () => {
    const params = generateSignedUrlParams({ documentId: DOC_ID, customerId: CUST_ID });
    const future = Math.floor(Date.now() / 1000) + 999_999;
    const result = validateSignedUrl({ ...params, exp: String(future) });
    expect(result.valid).toBe(false);
  });

  it("rejects when sig is truncated", () => {
    const params = generateSignedUrlParams({ documentId: DOC_ID, customerId: CUST_ID });
    const result = validateSignedUrl({ ...params, sig: params.sig.slice(0, 10) });
    expect(result.valid).toBe(false);
  });

  it("rejects a completely forged sig", () => {
    const params = generateSignedUrlParams({ documentId: DOC_ID, customerId: CUST_ID });
    const result = validateSignedUrl({
      ...params,
      sig: "a".repeat(64),
    });
    expect(result.valid).toBe(false);
  });
});

describe("validateSignedUrl — missing parameters", () => {
  it("rejects when doc is missing", () => {
    const { doc: _, ...params } = generateSignedUrlParams({
      documentId: DOC_ID,
      customerId: CUST_ID,
    });
    const result = validateSignedUrl(params);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it("rejects when sig is missing", () => {
    const { sig: _, ...params } = generateSignedUrlParams({
      documentId: DOC_ID,
      customerId: CUST_ID,
    });
    const result = validateSignedUrl(params);
    expect(result.valid).toBe(false);
  });

  it("rejects an empty object", () => {
    const result = validateSignedUrl({});
    expect(result.valid).toBe(false);
  });

  it("rejects when exp is not a number", () => {
    const params = generateSignedUrlParams({ documentId: DOC_ID, customerId: CUST_ID });
    const result = validateSignedUrl({ ...params, exp: "not-a-number" });
    expect(result.valid).toBe(false);
  });
});
