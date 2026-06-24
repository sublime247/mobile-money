import { describe, expect, it, beforeEach, afterAll, jest } from "@jest/globals";
import { encryptField, decryptField, getEncryptionKeys } from "../../src/utils/encryption";

describe("Dynamic PII Encryption and Key Rotation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should encrypt and decrypt using legacy default key when no active version is set", () => {
    const plaintext = "sensitive payload";
    const encrypted = encryptField(plaintext);
    expect(encrypted).toBeDefined();
    expect(encrypted!.startsWith("v1:")).toBe(false);
    expect(encrypted!.split(":").length).toBe(3);

    const decrypted = decryptField(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("should encrypt and decrypt using active version v1 prefix", () => {
    process.env.ACTIVE_ENCRYPTION_KEY_VERSION = "v1";
    process.env.DB_ENCRYPTION_KEY_V1 = "dynamic-key-v1-32-characters!!!!";

    const plaintext = "v1 sensitive payload";
    const encrypted = encryptField(plaintext);
    expect(encrypted).toBeDefined();
    expect(encrypted).toBeDefined();
    expect(encrypted!.startsWith("v1:")).toBe(true);

    const decrypted = decryptField(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("should support dynamic keys from DB_ENCRYPTION_KEYS JSON map", () => {
    process.env.DB_ENCRYPTION_KEYS = JSON.stringify({
      v2: "dynamic-key-v2-32-characters!!!!",
      v3: "dynamic-key-v3-32-characters!!!!",
    });

    // Encrypt using v2
    process.env.ACTIVE_ENCRYPTION_KEY_VERSION = "v2";
    const plaintextV2 = "v2 payload";
    const encryptedV2 = encryptField(plaintextV2);
    expect(encryptedV2!.startsWith("v2:")).toBe(true);
    expect(decryptField(encryptedV2)).toBe(plaintextV2);

    // Encrypt using v3
    process.env.ACTIVE_ENCRYPTION_KEY_VERSION = "v3";
    const plaintextV3 = "v3 payload";
    const encryptedV3 = encryptField(plaintextV3);
    expect(encryptedV3!.startsWith("v3:")).toBe(true);
    expect(decryptField(encryptedV3)).toBe(plaintextV3);
  });

  it("should seamlessly fallback and decrypt legacy payloads encrypted without version prefixes", () => {
    // Encrypt in legacy mode
    delete process.env.ACTIVE_ENCRYPTION_KEY_VERSION;
    const plaintext = "legacy fallback payload";
    const encryptedLegacy = encryptField(plaintext);
    expect(encryptedLegacy!.split(":").length).toBe(3);

    // Set active version to v1 (simulating key rotation in progress)
    process.env.ACTIVE_ENCRYPTION_KEY_VERSION = "v1";
    process.env.DB_ENCRYPTION_KEY_V1 = "dynamic-key-v1-32-characters!!!!";

    // Decrypt the legacy payload — should dynamically fallback and succeed
    const decrypted = decryptField(encryptedLegacy);
    expect(decrypted).toBe(plaintext);
  });
});
