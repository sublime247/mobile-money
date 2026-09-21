import {
  isEncryptedValue,
  encryptSecret,
  decryptSecret,
  encryptModelFields,
  decryptModelFields,
} from "../crypto";

describe("Credential encryption helpers (#2031)", () => {
  const originalKey = process.env.DB_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.DB_ENCRYPTION_KEY =
      originalKey || "development-encryption-key-32-chars-long";
  });

  afterAll(() => {
    process.env.DB_ENCRYPTION_KEY = originalKey;
  });

  describe("isEncryptedValue", () => {
    it("recognises a serialized AES-256-GCM payload", () => {
      expect(isEncryptedValue(encryptSecret("super-secret"))).toBe(true);
    });

    it("recognises a versioned payload", () => {
      const versioned = `v1:${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(
        16,
      )}`;
      expect(isEncryptedValue(versioned)).toBe(true);
    });

    it("rejects plaintext and non-string values", () => {
      expect(isEncryptedValue("plain-api-key")).toBe(false);
      expect(isEncryptedValue("SDUHELR2QJTQH24GZKNCT5NBWJ2FCGMP")).toBe(false);
      expect(isEncryptedValue(undefined)).toBe(false);
      expect(isEncryptedValue(null)).toBe(false);
      expect(isEncryptedValue(42)).toBe(false);
    });
  });

  describe("encryptSecret / decryptSecret", () => {
    it("round-trips a credential", () => {
      const plaintext = "sk_live_abc123+-/";
      const encrypted = encryptSecret(plaintext);

      expect(encrypted).toBeDefined();
      expect(encrypted).not.toBe(plaintext);
      expect(decryptSecret(encrypted)).toBe(plaintext);
    });

    it("round-trips a Stellar seed key", () => {
      const seed = "SDUHELR2QJTQH24GZKNCT5NBWJ2FCGMPRGKED5Y4REUZK4XCM73JMM4V";
      expect(decryptSecret(encryptSecret(seed))).toBe(seed);
    });

    it("is idempotent and does not double-encrypt", () => {
      const once = encryptSecret("api-secret");
      const twice = encryptSecret(once);
      expect(twice).toBe(once);
      expect(decryptSecret(twice)).toBe("api-secret");
    });

    it("passes through null / undefined / empty values", () => {
      expect(encryptSecret(null)).toBeNull();
      expect(encryptSecret(undefined)).toBeUndefined();
      expect(encryptSecret("")).toBe("");
      expect(decryptSecret(null)).toBeNull();
      expect(decryptSecret(undefined)).toBeUndefined();
      expect(decryptSecret("")).toBe("");
    });

    it("passes through legacy plaintext rows untouched", () => {
      expect(decryptSecret("not-yet-encrypted")).toBe("not-yet-encrypted");
    });

    it("detects tampering with the ciphertext (auth tag mismatch)", () => {
      const encrypted = encryptSecret("tamper-me")!;
      const parts = encrypted.split(":");
      const ciphertext = parts[parts.length - 1];
      const flipped = (ciphertext[0] === "0" ? "1" : "0") + ciphertext.slice(1);
      parts[parts.length - 1] = flipped;

      expect(() => decryptSecret(parts.join(":"))).toThrow();
    });

    it("detects tampering with the authentication tag", () => {
      const encrypted = encryptSecret("tamper-me")!;
      const parts = encrypted.split(":");
      // parts = [iv, authTag, ciphertext]
      const tag = parts[1];
      parts[1] = (tag[0] === "0" ? "1" : "0") + tag.slice(1);

      expect(() => decryptSecret(parts.join(":"))).toThrow();
    });

    it("rejects decryption with the wrong master key", () => {
      process.env.DB_ENCRYPTION_KEY = "first-master-key-32-characters-long";
      const encrypted = encryptSecret("rotation-secret")!;
      expect(decryptSecret(encrypted)).toBe("rotation-secret");

      process.env.DB_ENCRYPTION_KEY = "second-master-key-32-chars-long!!!!";
      expect(() => decryptSecret(encrypted)).toThrow();
    });
  });

  describe("encryptModelFields / decryptModelFields", () => {
    const fields = ["api_key", "api_secret"] as const;

    it("encrypts only the requested fields and decrypts them back", () => {
      const row = {
        provider: "mtn",
        api_key: "key-123",
        api_secret: "secret-456",
        api_endpoint: "https://example.test/report",
      };

      const encrypted = encryptModelFields(row, fields);
      expect(isEncryptedValue(encrypted.api_key)).toBe(true);
      expect(isEncryptedValue(encrypted.api_secret)).toBe(true);
      expect(encrypted.api_endpoint).toBe(row.api_endpoint);
      expect(encrypted.provider).toBe("mtn");

      const decrypted = decryptModelFields(encrypted, fields);
      expect(decrypted.api_key).toBe("key-123");
      expect(decrypted.api_secret).toBe("secret-456");
    });

    it("handles missing fields without throwing", () => {
      const row = { provider: "airtel" };
      const encrypted = encryptModelFields(row, fields);
      expect(encrypted).toEqual({ provider: "airtel" });
      expect(decryptModelFields(encrypted, fields)).toEqual({
        provider: "airtel",
      });
    });
  });
});
