/**
 * src/services/__tests__/credentialEncryption.test.ts
 *
 * Test suite for credential encryption service.
 * Verifies AES-256-GCM encryption/decryption of sensitive database fields
 * with IV reuse prevention and authentication tag verification.
 */

import {
  encryptCredential,
  decryptCredential,
  encryptSensitiveField,
  decryptSensitiveField,
  applyEncryptionHook,
  applyDecryptionHook,
  CredentialType,
} from "../credentialEncryption";

describe("Credential Encryption Service (#2031)", () => {
  describe("encryptCredential & decryptCredential", () => {
    it("should encrypt and decrypt a merchant API secret", () => {
      const apiSecret = "sk_prod_1234567890abcdef";
      const encrypted = encryptCredential(
        apiSecret,
        CredentialType.MERCHANT_API_SECRET,
      );

      expect(encrypted).toBeDefined();
      expect(encrypted).not.toBe(apiSecret);
      expect(typeof encrypted).toBe("string");

      const decrypted = decryptCredential(
        encrypted,
        CredentialType.MERCHANT_API_SECRET,
      );
      expect(decrypted).toBe(apiSecret);
    });

    it("should encrypt and decrypt a Stellar seed key", () => {
      const stellarSeed =
        "SBGWKM3CD4IL47QN6X54BUGXVRVMN4ZJWUJXJ34B4J4FCTSZ5RYABFT";
      const encrypted = encryptCredential(
        stellarSeed,
        CredentialType.STELLAR_SEED_KEY,
      );

      expect(encrypted).not.toBe(stellarSeed);
      const decrypted = decryptCredential(
        encrypted,
        CredentialType.STELLAR_SEED_KEY,
      );
      expect(decrypted).toBe(stellarSeed);
    });

    it("should encrypt and decrypt a provider API key", () => {
      const providerKey = "api_key_12345_67890_abcde";
      const encrypted = encryptCredential(
        providerKey,
        CredentialType.PROVIDER_API_KEY,
      );

      expect(encrypted).not.toBe(providerKey);
      const decrypted = decryptCredential(
        encrypted,
        CredentialType.PROVIDER_API_KEY,
      );
      expect(decrypted).toBe(providerKey);
    });

    it("should generate unique ciphertexts for the same plaintext (random IV)", () => {
      const secret = "same_secret_123";
      const encrypted1 = encryptCredential(
        secret,
        CredentialType.WEBHOOK_SECRET,
      );
      const encrypted2 = encryptCredential(
        secret,
        CredentialType.WEBHOOK_SECRET,
      );

      // Different IVs produce different ciphertexts even for identical plaintext
      expect(encrypted1).not.toBe(encrypted2);

      // Both should decrypt to the same plaintext
      expect(decryptCredential(encrypted1, CredentialType.WEBHOOK_SECRET)).toBe(
        secret,
      );
      expect(decryptCredential(encrypted2, CredentialType.WEBHOOK_SECRET)).toBe(
        secret,
      );
    });

    it("should detect tampering with the ciphertext", () => {
      const secret = "sensitive_data_123";
      const encrypted = encryptCredential(
        secret,
        CredentialType.WEBHOOK_SECRET,
      );

      // Tamper with the ciphertext part (after the auth tag)
      const parts = encrypted.split(":");
      if (parts.length === 3) {
        // Format: iv:authTag:ciphertext
        parts[2] = "ff" + parts[2].slice(2); // Flip a bit in ciphertext
        const tampered = parts.join(":");

        expect(() =>
          decryptCredential(tampered, CredentialType.WEBHOOK_SECRET),
        ).toThrow();
      }
    });

    it("should detect tampering with the auth tag", () => {
      const secret = "secure_credential";
      const encrypted = encryptCredential(
        secret,
        CredentialType.OAUTH_TOKEN,
      );

      // Tamper with the auth tag
      const parts = encrypted.split(":");
      if (parts.length === 3) {
        parts[1] = "ff" + parts[1].slice(2); // Flip a bit in auth tag
        const tampered = parts.join(":");

        expect(() =>
          decryptCredential(tampered, CredentialType.OAUTH_TOKEN),
        ).toThrow();
      }
    });

    it("should throw on empty credential plaintext", () => {
      expect(() =>
        encryptCredential("", CredentialType.MERCHANT_API_SECRET),
      ).toThrow();
    });

    it("should throw on empty encrypted value during decryption", () => {
      expect(() =>
        decryptCredential("", CredentialType.MERCHANT_API_SECRET),
      ).toThrow();
    });
  });

  describe("encryptSensitiveField & decryptSensitiveField", () => {
    it("should transparently encrypt and decrypt sensitive fields", () => {
      const plaintext = "secret_value_123";
      const encrypted = encryptSensitiveField(plaintext);

      expect(encrypted).toBeDefined();
      expect(encrypted).not.toBe(plaintext);

      const decrypted = decryptSensitiveField(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("should preserve null and undefined values", () => {
      expect(encryptSensitiveField(null)).toBeNull();
      expect(encryptSensitiveField(undefined)).toBeUndefined();
      expect(decryptSensitiveField(null)).toBeNull();
      expect(decryptSensitiveField(undefined)).toBeUndefined();
    });

    it("should preserve empty strings", () => {
      expect(encryptSensitiveField("")).toBe("");
      expect(decryptSensitiveField("")).toBe("");
    });
  });

  describe("applyEncryptionHook & applyDecryptionHook", () => {
    it("should encrypt specified fields in an object", () => {
      const input = {
        id: "merchant-123",
        name: "ACME Corp",
        apiSecret: "sk_live_secret_key_123",
        stellarSeed: "SBGWKM3CD4IL47QN6X54BUGXVRVMN4Z",
      };

      const encrypted = applyEncryptionHook(input, [
        "apiSecret",
        "stellarSeed",
      ]);

      // Sensitive fields should be encrypted
      expect(encrypted.apiSecret).not.toBe(input.apiSecret);
      expect(encrypted.stellarSeed).not.toBe(input.stellarSeed);

      // Non-sensitive fields should remain unchanged
      expect(encrypted.id).toBe(input.id);
      expect(encrypted.name).toBe(input.name);
    });

    it("should decrypt specified fields in an object", () => {
      const original = {
        id: "merchant-456",
        apiSecret: "sk_test_1234567890",
        status: "active",
      };

      const encrypted = applyEncryptionHook(original, ["apiSecret"]);
      const decrypted = applyDecryptionHook(encrypted, ["apiSecret"]);

      expect(decrypted.apiSecret).toBe(original.apiSecret);
      expect(decrypted.id).toBe(original.id);
      expect(decrypted.status).toBe(original.status);
    });

    it("should handle null values in applyEncryptionHook", () => {
      const input = {
        id: "merchant-789",
        apiSecret: "secret_key",
        webhookSecret: null,
      };

      const encrypted = applyEncryptionHook(input, [
        "apiSecret",
        "webhookSecret",
      ]);

      expect(encrypted.apiSecret).not.toBe(input.apiSecret);
      expect(encrypted.webhookSecret).toBeNull();
    });

    it("should handle null values in applyDecryptionHook", () => {
      const encrypted = {
        id: "merchant-999",
        apiSecret: "encrypted_value_here",
        webhookSecret: null,
      };

      const decrypted = applyDecryptionHook(encrypted, [
        "apiSecret",
        "webhookSecret",
      ]);

      expect(decrypted.webhookSecret).toBeNull();
    });

    it("should skip non-string values in applyEncryptionHook", () => {
      const input = {
        id: "merchant-aaa",
        apiSecret: "secret",
        count: 42,
        isActive: true,
      };

      const encrypted = applyEncryptionHook(input, [
        "apiSecret",
        "count",
        "isActive",
      ]);

      expect(encrypted.apiSecret).not.toBe(input.apiSecret);
      expect(encrypted.count).toBe(42);
      expect(encrypted.isActive).toBe(true);
    });

    it("should work with roundtrip encryption-decryption", () => {
      const merchant = {
        id: "merchant-xyz",
        name: "Test Merchant",
        apiSecret: "sk_prod_abcdef123456",
        stellarPublicKey: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTWYV2KY5GADJ4@stellar.org",
        webhookSecret: "whsec_1234567890",
      };

      // Simulate a database round-trip
      const toStore = applyEncryptionHook(merchant, [
        "apiSecret",
        "webhookSecret",
      ]);

      // Simulate reading from database
      const fromDb = toStore; // (normally fetched from DB)

      // Decrypt for application use
      const toUse = applyDecryptionHook(fromDb, [
        "apiSecret",
        "webhookSecret",
      ]);

      expect(toUse.apiSecret).toBe(merchant.apiSecret);
      expect(toUse.webhookSecret).toBe(merchant.webhookSecret);
      expect(toUse.stellarPublicKey).toBe(merchant.stellarPublicKey); // Not encrypted, should be unchanged
      expect(toUse.name).toBe(merchant.name);
    });
  });

  describe("IV Uniqueness & Randomness", () => {
    it("should use unique IVs for each encryption operation", () => {
      const plaintext = "test_credential_data";
      const encryptedSet = new Set<string>();

      // Encrypt the same plaintext 100 times
      for (let i = 0; i < 100; i++) {
        const encrypted = encryptCredential(
          plaintext,
          CredentialType.PROVIDER_API_KEY,
        );
        encryptedSet.add(encrypted);
      }

      // All ciphertexts should be unique due to random IVs
      expect(encryptedSet.size).toBe(100);
    });
  });

  describe("Large Credential Strings", () => {
    it("should handle long API credentials (e.g., OAuth tokens)", () => {
      const longToken =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFjbWUgTWVyY2hhbnQiLCJpYXQiOjE1MTYyMzkwMjJ9.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ.extra_long_token_part_that_extends_the_jwt_payload_indefinitely_with_additional_claims_and_signatures_for_testing_purposes";
      const encrypted = encryptCredential(
        longToken,
        CredentialType.OAUTH_TOKEN,
      );
      const decrypted = decryptCredential(encrypted, CredentialType.OAUTH_TOKEN);

      expect(decrypted).toBe(longToken);
    });
  });
});
