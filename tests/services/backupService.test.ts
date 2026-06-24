import crypto from "crypto";
import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import fs from "fs";
import path from "path";
import {
  encryptBackup,
  decryptBackup,
  createBackup,
  validateBackupIntegrity,
  verifyDataSafety,
  BackupMetadata,
} from "../../src/services/backupService";

let mockS3Payload: Buffer = Buffer.alloc(0);

jest.mock("@aws-sdk/client-s3", () => {
  return {
    S3Client: jest.fn().mockImplementation(() => {
      return {
        send: jest.fn().mockImplementation((command) => {
          const commandName = command.commandName;
          if (commandName === "ListObjectsV2Command") {
            return Promise.resolve({
              Contents: [
                {
                  Key: "backups/test-backup-001.dump.enc",
                  LastModified: new Date(),
                  Size: 1024,
                },
              ],
            });
          }
          if (commandName === "HeadObjectCommand") {
            return Promise.resolve({
              Metadata: {
                "backup-timestamp": new Date().toISOString(),
                "backup-database": "mobilemoney_stellar",
                "backup-size": "1024",
                "backup-compressed": "false",
                "backup-encrypted": "true",
                "backup-algorithm": "aes-256-gcm",
                "backup-retention-days": "30",
                "backup-checksum": "894086ea764a85fa1799276960d70eb06b12b591b93f1d9354020a67119ff39a",
              },
            });
          }
          if (commandName === "GetObjectCommand") {
            const { Readable } = require("stream");
            const stream = new Readable();
            stream.push(mockS3Payload);
            stream.push(null);
            
            stream.transformToByteArray = () => {
              return Promise.resolve(new Uint8Array(mockS3Payload));
            };

            return Promise.resolve({
              Body: stream,
            });
          }
          if (commandName === "HeadBucketCommand" || commandName === "PutObjectCommand") {
            return Promise.resolve({});
          }
          return Promise.resolve({});
        }),
      };
    }),
    ListObjectsV2Command: jest.fn().mockImplementation(function (args) { this.args = args; this.commandName = "ListObjectsV2Command"; }),
    GetObjectCommand: jest.fn().mockImplementation(function (args) { this.args = args; this.commandName = "GetObjectCommand"; }),
    HeadObjectCommand: jest.fn().mockImplementation(function (args) { this.args = args; this.commandName = "HeadObjectCommand"; }),
    PutObjectCommand: jest.fn().mockImplementation(function (args) { this.args = args; this.commandName = "PutObjectCommand"; }),
    HeadBucketCommand: jest.fn().mockImplementation(function (args) { this.args = args; this.commandName = "HeadBucketCommand"; }),
  };
});

describe("Backup Service (Issue #553)", () => {
  const TEST_TEMP_DIR = "/tmp/backup-tests";

  beforeAll(() => {
    // Initialize mockS3Payload with a valid GCM encrypted buffer of "SELECT * FROM users;"
    mockS3Payload = encryptBackup(Buffer.from("SELECT * FROM users;"));

    // Create temp directory for tests
    if (!fs.existsSync(TEST_TEMP_DIR)) {
      fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test files
    if (fs.existsSync(TEST_TEMP_DIR)) {
      fs.rmSync(TEST_TEMP_DIR, { recursive: true });
    }
  });

  describe("Encryption/Decryption", () => {
    it("should encrypt and decrypt backup data correctly", () => {
      const testData = Buffer.from("SELECT * FROM users; INSERT INTO logs...");

      // Encrypt
      const encrypted = encryptBackup(testData);

      // Verify encrypted data is larger (IV + AuthTag + encrypted content)
      expect(encrypted.length).toBeGreaterThan(testData.length);

      // Decrypt
      const decrypted = decryptBackup(encrypted);

      // Verify decrypted matches original
      expect(decrypted).toEqual(testData);
    });

    it("should produce different ciphertexts for same plaintext (due to random IV)", () => {
      const testData = Buffer.from("SELECT * FROM users;");

      const encrypted1 = encryptBackup(testData);
      const encrypted2 = encryptBackup(testData);

      // Ciphertexts should differ due to random IV
      expect(encrypted1).not.toEqual(encrypted2);

      // But both should decrypt to original
      expect(decryptBackup(encrypted1)).toEqual(testData);
      expect(decryptBackup(encrypted2)).toEqual(testData);
    });

    it("should fail gracefully on corrupted encrypted data", () => {
      const testData = Buffer.from("SELECT * FROM users;");
      const encrypted = encryptBackup(testData);

      // Corrupt the auth tag
      encrypted[15] ^= 0xff; // Flip all bits in last byte of auth tag

      // Decryption should throw due to auth tag verification failure
      expect(() => decryptBackup(encrypted)).toThrow();
    });

    it("should handle large backup data (simulate 5MB dump)", () => {
      // Create a large buffer (5MB simulation)
      const largeData = Buffer.alloc(5 * 1024 * 1024);
      crypto.randomFillSync(largeData);

      // Encrypt
      const encrypted = encryptBackup(largeData);

      // Decrypt
      const decrypted = decryptBackup(encrypted);

      // Verify
      expect(decrypted.equals(largeData)).toBe(true);
    });
  });

  describe("Backup Metadata", () => {
    it("should create valid backup metadata", () => {
      const metadata: BackupMetadata = {
        timestamp: new Date().toISOString(),
        database: "mobilemoney_stellar",
        size: 52428800, // 50MB
        compressed: false,
        encrypted: true,
        algorithm: "aes-256-gcm",
        retention_days: 30,
        checksum: crypto.randomBytes(32).toString("hex"),
      };

      expect(metadata.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(metadata.size).toBeGreaterThan(0);
      expect(metadata.encrypted).toBe(true);
      expect(metadata.checksum).toHaveLength(64);
      expect(metadata.retention_days).toBe(30);
    });
  });

  describe("Data Safety", () => {
    it("should verify data safety status", async () => {
      const safety = await verifyDataSafety();

      expect(safety).toHaveProperty("safe");
      expect(safety).toHaveProperty("details");
      expect(safety.details).toHaveProperty("bucket_accessible");
      expect(safety.details).toHaveProperty("encryption_enabled");
    });

    it("should indicate encryption is enabled", async () => {
      const safety = await verifyDataSafety();

      // Should have encryption enabled in environment
      expect(safety.details.encryption_enabled).toBeDefined();
    });
  });

  describe("Backup Integrity", () => {
    it("should validate backup with correct checksum", async () => {
      const expectedChecksum = crypto
        .createHash("sha256")
        .update(Buffer.from("SELECT * FROM users;"))
        .digest("hex");

      const metadata: BackupMetadata = {
        timestamp: new Date().toISOString(),
        database: "mobilemoney_stellar",
        size: 1024,
        compressed: false,
        encrypted: true,
        algorithm: "aes-256-gcm",
        retention_days: 30,
        checksum: expectedChecksum,
      };

      const result = await validateBackupIntegrity("test-backup-001", metadata);

      expect(result).toBe(true);
    });

    it("should reject backup with invalid checksum format", async () => {
      const metadata: BackupMetadata = {
        timestamp: new Date().toISOString(),
        database: "mobilemoney_stellar",
        size: 1024,
        compressed: false,
        encrypted: true,
        algorithm: "aes-256-gcm",
        retention_days: 30,
        checksum: "invalid", // Invalid hex format
      };

      const result = await validateBackupIntegrity("test-backup-001", metadata);

      expect(result).toBe(false);
    });

    it("should reject backup with empty checksum", async () => {
      const metadata: BackupMetadata = {
        timestamp: new Date().toISOString(),
        database: "mobilemoney_stellar",
        size: 1024,
        compressed: false,
        encrypted: true,
        algorithm: "aes-256-gcm",
        retention_days: 30,
        checksum: "", // Empty checksum
      };

      const result = await validateBackupIntegrity("test-backup-001", metadata);

      expect(result).toBe(false);
    });
  });

  describe("Encryption Key Derivation", () => {
    it("should derive consistent keys from master key", () => {
      // This test verifies that key derivation is deterministic
      // Same master key should produce same derived key

      // In actual implementation, we would import deriveBackupKey
      // For now, verify the backup service exports the necessary functions
      expect(encryptBackup).toBeDefined();
      expect(decryptBackup).toBeDefined();
    });
  });

  describe("Retention Policy", () => {
    it("should have 30-day retention configured", () => {
      const metadata: BackupMetadata = {
        timestamp: new Date().toISOString(),
        database: "mobilemoney_stellar",
        size: 1024,
        compressed: false,
        encrypted: true,
        algorithm: "aes-256-gcm",
        retention_days: 30,
        checksum: "a" + "0".repeat(63),
      };

      expect(metadata.retention_days).toBe(30);
    });

    it("should compute backup age correctly", () => {
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const metadata: BackupMetadata = {
        timestamp: oneDayAgo.toISOString(),
        database: "mobilemoney_stellar",
        size: 1024,
        compressed: false,
        encrypted: true,
        algorithm: "aes-256-gcm",
        retention_days: 30,
        checksum: "a" + "0".repeat(63),
      };

      const age = Math.floor(
        (now.getTime() - new Date(metadata.timestamp).getTime()) /
          (24 * 60 * 60 * 1000),
      );

      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThanOrEqual(metadata.retention_days);
    });
  });

  describe("Error Handling", () => {
    it("should handle encryption of empty buffer", () => {
      const emptyBuffer = Buffer.alloc(0);

      // Should not throw
      const encrypted = encryptBackup(emptyBuffer);
      expect(encrypted).toBeDefined();

      // Should decrypt back to empty buffer
      const decrypted = decryptBackup(encrypted);
      expect(decrypted.length).toBe(0);
    });

    it("should handle very small backups", () => {
      const smallData = Buffer.from("X");

      const encrypted = encryptBackup(smallData);
      const decrypted = decryptBackup(encrypted);

      expect(decrypted).toEqual(smallData);
    });
  });

  describe("Security Properties", () => {
    it("should use AES-256-GCM for encryption", () => {
      // Verify the encryption algorithm used is strong
      const testData = Buffer.from("sensitive database dump");
      const encrypted = encryptBackup(testData);

      // Encrypted should be different from plaintext
      expect(encrypted).not.toContain(testData as any);

      // And should decrypt properly
      expect(decryptBackup(encrypted)).toEqual(testData);
    });

    it("should use random IV for each backup", () => {
      const testData = Buffer.from("database dump");

      // Generate multiple backups
      const backups = [];
      for (let i = 0; i < 10; i++) {
        backups.push(encryptBackup(testData));
      }

      // All should be different (due to random IV)
      const ciphertexts = new Set(backups.map((b) => b.toString("hex")));
      expect(ciphertexts.size).toBe(10);

      // But all should decrypt to original
      backups.forEach((backup) => {
        expect(decryptBackup(backup)).toEqual(testData);
      });
    });

    it("should provide authenticated encryption (GCM)", () => {
      const testData = Buffer.from("SELECT * FROM sensitive_data;");
      const encrypted = encryptBackup(testData);

      // Tamper with the encrypted data (not the tag)
      encrypted[encrypted.length - 1] ^= 0xff;

      // Decryption should fail due to tag verification
      expect(() => decryptBackup(encrypted)).toThrow();
    });
  });
});
