import { randomBytes } from "crypto";
import {
  encryptCustomerPii,
  decryptCustomerPii,
  type EnvelopeEncryptedRecord,
} from "../envelopeEncryption";
import {
  LocalKeyManagementProvider,
  type KeyManagementProvider,
} from "../kmsProvider";

const MASTER_KEY = randomBytes(32);

function makeProvider(): KeyManagementProvider {
  return new LocalKeyManagementProvider(MASTER_KEY, "v1");
}

describe("envelope encryption for customer PII (#2379)", () => {
  describe("encryptCustomerPii / decryptCustomerPii round trip", () => {
    it("encrypts and decrypts all three PII fields back to their original values", async () => {
      const provider = makeProvider();
      const record = await encryptCustomerPii(
        {
          phone: "+15551234567",
          nationalId: "A1234567",
          bankIban: "GB29NWBK60161331926819",
        },
        "customer:user-1",
        provider,
      );

      const decrypted = await decryptCustomerPii(
        record,
        "customer:user-1",
        provider,
      );

      expect(decrypted).toEqual({
        phone: "+15551234567",
        nationalId: "A1234567",
        bankIban: "GB29NWBK60161331926819",
      });
    });

    it("skips absent/null/empty fields rather than encrypting them", async () => {
      const provider = makeProvider();
      const record = await encryptCustomerPii(
        { phone: "+15551234567", nationalId: null, bankIban: "" },
        "customer:user-2",
        provider,
      );

      expect(record.fields.phone).toBeDefined();
      expect(record.fields.nationalId).toBeUndefined();
      expect(record.fields.bankIban).toBeUndefined();

      const decrypted = await decryptCustomerPii(
        record,
        "customer:user-2",
        provider,
      );
      expect(decrypted).toEqual({ phone: "+15551234567" });
    });

    it("generates a unique DEK per record — two records for the same field value have different ciphertext and wrapped keys", async () => {
      const provider = makeProvider();
      const recordA = await encryptCustomerPii(
        { phone: "+15551234567" },
        "customer:user-a",
        provider,
      );
      const recordB = await encryptCustomerPii(
        { phone: "+15551234567" },
        "customer:user-b",
        provider,
      );

      expect(recordA.dataKey.wrappedKey).not.toBe(recordB.dataKey.wrappedKey);
      expect(recordA.fields.phone!.ciphertext).not.toBe(
        recordB.fields.phone!.ciphertext,
      );
    });

    it("never returns the plaintext DEK — only the wrapped form is present on the result", async () => {
      const provider = makeProvider();
      const record = await encryptCustomerPii(
        { phone: "+15551234567" },
        "customer:user-3",
        provider,
      );

      expect(record.dataKey).toHaveProperty("wrappedKey");
      expect(record.dataKey).toHaveProperty("iv");
      expect(record.dataKey).toHaveProperty("authTag");
      expect(record.dataKey).toHaveProperty("keyVersion");
      // The wrapped key must not equal any recognisable plaintext — it's
      // ciphertext, so it can never equal the original phone number.
      expect(record.dataKey.wrappedKey).not.toContain("15551234567");
    });
  });

  describe("tampering detection (GCM auth tag)", () => {
    let provider: KeyManagementProvider;
    let record: EnvelopeEncryptedRecord;

    beforeEach(async () => {
      provider = makeProvider();
      record = await encryptCustomerPii(
        { phone: "+15551234567", bankIban: "GB29NWBK60161331926819" },
        "customer:user-4",
        provider,
      );
    });

    it("fails to decrypt when a field's ciphertext is tampered with", async () => {
      const tampered: EnvelopeEncryptedRecord = {
        ...record,
        fields: {
          ...record.fields,
          phone: {
            ...record.fields.phone!,
            ciphertext: record.fields.phone!.ciphertext.replace(/^.{2}/, "ff"),
          },
        },
      };

      await expect(
        decryptCustomerPii(tampered, "customer:user-4", provider),
      ).rejects.toThrow();
    });

    it("fails to decrypt when a field's auth tag is tampered with", async () => {
      const tampered: EnvelopeEncryptedRecord = {
        ...record,
        fields: {
          ...record.fields,
          bankIban: {
            ...record.fields.bankIban!,
            authTag: record.fields.bankIban!.authTag.replace(/^.{2}/, "ff"),
          },
        },
      };

      await expect(
        decryptCustomerPii(tampered, "customer:user-4", provider),
      ).rejects.toThrow();
    });

    it("fails to decrypt when the wrapped DEK's ciphertext is tampered with", async () => {
      const tampered: EnvelopeEncryptedRecord = {
        ...record,
        dataKey: {
          ...record.dataKey,
          wrappedKey: record.dataKey.wrappedKey.replace(/^.{2}/, "ff"),
        },
      };

      await expect(
        decryptCustomerPii(tampered, "customer:user-4", provider),
      ).rejects.toThrow();
    });

    it("fails to decrypt when the wrapped DEK's auth tag is tampered with", async () => {
      const tampered: EnvelopeEncryptedRecord = {
        ...record,
        dataKey: {
          ...record.dataKey,
          authTag: record.dataKey.authTag.replace(/^.{2}/, "ff"),
        },
      };

      await expect(
        decryptCustomerPii(tampered, "customer:user-4", provider),
      ).rejects.toThrow();
    });

    it("fails to decrypt when a ciphertext is copied onto a different customer's context (AAD context binding)", async () => {
      await expect(
        decryptCustomerPii(record, "customer:different-user", provider),
      ).rejects.toThrow();
    });

    it("fails to decrypt when wrapped with a different master key", async () => {
      const otherProvider = new LocalKeyManagementProvider(
        randomBytes(32),
        "v1",
      );

      await expect(
        decryptCustomerPii(record, "customer:user-4", otherProvider),
      ).rejects.toThrow();
    });
  });

  describe("LocalKeyManagementProvider", () => {
    it("throws a clear error when constructed with a key that isn't 32 bytes", () => {
      expect(() => new LocalKeyManagementProvider(randomBytes(16), "v1")).toThrow(
        /32 bytes/,
      );
    });

    it("rejects unwrapping a DEK wrapped under a key version it doesn't hold", async () => {
      const provider = makeProvider();
      const record = await encryptCustomerPii(
        { phone: "+15551234567" },
        "customer:user-5",
        provider,
      );

      const providerV2 = new LocalKeyManagementProvider(MASTER_KEY, "v2");

      await expect(
        decryptCustomerPii(record, "customer:user-5", providerV2),
      ).rejects.toThrow(/no master key configured/);
    });

    it("reports its provider name as 'local'", () => {
      expect(makeProvider().providerName).toBe("local");
    });
  });
});
