import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { TwoFactorWithdrawalService } from "../twoFactorWithdrawalService";
import { UserModel } from "../../models/users";
import {
  is2FAEnabled,
  verifyTOTPToken,
  generateBackupCodes,
  hashBackupCodes,
} from "../../auth/2fa";
import { pool } from "../../config/database";
import { twoFactorRateLimiter } from "../twoFactorRateLimiter";
import bcrypt from "bcrypt";

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock("../../models/users");

jest.mock("../../auth/2fa", () => ({
  is2FAEnabled: jest.fn(),
  verifyTOTPToken: jest.fn(),
  generateBackupCodes: jest.fn(),
  hashBackupCodes: jest.fn(),
}));

jest.mock("../../config/database", () => ({
  pool: { connect: jest.fn() },
}));

jest.mock("../twoFactorRateLimiter", () => ({
  twoFactorRateLimiter: {
    isLocked: jest.fn(),
    incrementFailures: jest.fn(),
    resetFailures: jest.fn(),
    getLockoutTimeRemaining: jest.fn(),
  },
}));

jest.mock("bcrypt");

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ── Shared fixtures ───────────────────────────────────────────────────────────

const PLAINTEXT_CODES = [
  "CODE0001",
  "CODE0002",
  "CODE0003",
  "CODE0004",
  "CODE0005",
  "CODE0006",
  "CODE0007",
  "CODE0008",
  "CODE0009",
  "CODE0010",
];
const HASHED_CODES = PLAINTEXT_CODES.map((_, i) => `hash${i + 1}`);

// Single shared mock client reused across all tests; cleared in beforeEach.
const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe("TwoFactorWithdrawalService", () => {
  let service: TwoFactorWithdrawalService;
  let mockUserModel: jest.Mocked<UserModel>;

  const mockUser = {
    id: "user-123",
    mandatory2FAWithdrawals: true,
    two_factor_secret: "secret123",
    two_factor_enabled: true,
    two_factor_verified: true,
  };

  const mockUserWithoutMandatory = {
    ...mockUser,
    mandatory2FAWithdrawals: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Wire up service with mocked UserModel
    mockUserModel = new UserModel() as jest.Mocked<UserModel>;
    service = new TwoFactorWithdrawalService();
    (service as any).userModel = mockUserModel;

    // 2FA helpers
    (is2FAEnabled as jest.Mock).mockReturnValue(true);
    (verifyTOTPToken as jest.Mock).mockReturnValue(true);
    (generateBackupCodes as jest.Mock).mockReturnValue(PLAINTEXT_CODES);
    (hashBackupCodes as jest.Mock).mockResolvedValue(HASHED_CODES);

    // DB pool — every pool.connect() returns the same mock client
    (pool.connect as jest.Mock).mockResolvedValue(mockClient);
    mockClient.query.mockResolvedValue({ rows: [] });
    mockClient.release.mockReturnValue(undefined);

    // Rate-limiter defaults (Redis unavailable scenario)
    (twoFactorRateLimiter.isLocked as jest.Mock).mockResolvedValue(false);
    (twoFactorRateLimiter.incrementFailures as jest.Mock).mockResolvedValue(1);
    (twoFactorRateLimiter.resetFailures as jest.Mock).mockResolvedValue(
      undefined,
    );
    (
      twoFactorRateLimiter.getLockoutTimeRemaining as jest.Mock
    ).mockResolvedValue(0);

    // bcrypt — default: no match
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
  });

  // ── requires2FAForWithdrawal ───────────────────────────────────────────────

  describe("requires2FAForWithdrawal", () => {
    it("should return true when user has mandatory 2FA withdrawals enabled", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);

      const result = await service.requires2FAForWithdrawal("user-123");

      expect(result).toBe(true);
      expect(mockUserModel.findById).toHaveBeenCalledWith("user-123");
    });

    it("should return false when user has mandatory 2FA withdrawals disabled", async () => {
      mockUserModel.findById.mockResolvedValue(mockUserWithoutMandatory as any);

      const result = await service.requires2FAForWithdrawal("user-123");

      expect(result).toBe(false);
    });

    it("should throw error when user not found", async () => {
      mockUserModel.findById.mockResolvedValue(null);

      await expect(
        service.requires2FAForWithdrawal("user-123"),
      ).rejects.toThrow("User not found");
    });
  });

  // ── verifyWithdrawal2FA ───────────────────────────────────────────────────

  describe("verifyWithdrawal2FA", () => {
    it("should return error when user not found", async () => {
      mockUserModel.findById.mockResolvedValue(null);

      const result = await service.verifyWithdrawal2FA({
        userId: "user-123",
        token: "123456",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("User not found");
    });

    it("should return error when 2FA not enabled", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);
      (is2FAEnabled as jest.Mock).mockReturnValue(false);

      const result = await service.verifyWithdrawal2FA({
        userId: "user-123",
        token: "123456",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("2FA not enabled for user");
    });

    it("should return error when mandatory 2FA withdrawals not enabled", async () => {
      mockUserModel.findById.mockResolvedValue(mockUserWithoutMandatory as any);

      const result = await service.verifyWithdrawal2FA({
        userId: "user-123",
        token: "123456",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "User has not opted into mandatory 2FA withdrawals",
      );
    });

    it("should return lockout error when user is locked", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);
      (twoFactorRateLimiter.isLocked as jest.Mock).mockResolvedValue(true);
      // 10 minutes remaining → Math.ceil(600 / 60) = 10
      (
        twoFactorRateLimiter.getLockoutTimeRemaining as jest.Mock
      ).mockResolvedValue(600);

      const result = await service.verifyWithdrawal2FA({
        userId: "user-123",
        token: "123456",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("2FA locked");
      expect(result.error).toContain("10 minutes");
    });

    it("should successfully verify with TOTP token", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);

      const result = await service.verifyWithdrawal2FA({
        userId: "user-123",
        token: "123456",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("totp");
      expect(twoFactorRateLimiter.resetFailures).toHaveBeenCalledWith(
        "user-123",
      );
    });

    it("should successfully verify with a valid backup code", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);
      (verifyTOTPToken as jest.Mock).mockReturnValue(false);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      // First query: SELECT unused codes
      // Second query: atomic UPDATE RETURNING — returns the row → code was not yet spent
      mockClient.query
        .mockResolvedValueOnce({
          rows: [{ id: "code-abc", code_hash: "hashed-code" }],
        })
        .mockResolvedValueOnce({ rows: [{ id: "code-abc" }] });

      const result = await service.verifyWithdrawal2FA({
        userId: "user-123",
        backupCode: "ABCD1234",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("backup");
      expect(twoFactorRateLimiter.resetFailures).toHaveBeenCalledWith(
        "user-123",
      );
    });

    it("should reject backup code that was concurrently spent (double-spend guard)", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);
      (verifyTOTPToken as jest.Mock).mockReturnValue(false);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      // SELECT finds the code, but UPDATE RETURNING returns 0 rows (already spent)
      mockClient.query
        .mockResolvedValueOnce({
          rows: [{ id: "code-abc", code_hash: "hashed-code" }],
        })
        .mockResolvedValueOnce({ rows: [] }); // 0 rows ⇒ concurrent request won the race

      const result = await service.verifyWithdrawal2FA({
        userId: "user-123",
        backupCode: "ABCD1234",
      });

      expect(result.success).toBe(false);
    });

    it("should return error with attempts remaining when neither token nor backup code is provided", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);
      (verifyTOTPToken as jest.Mock).mockReturnValue(false);
      // incrementFailures returns 1 → triesLeft = 3 - 1 = 2
      (twoFactorRateLimiter.incrementFailures as jest.Mock).mockResolvedValue(
        1,
      );

      const result = await service.verifyWithdrawal2FA({ userId: "user-123" });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "Invalid 2FA token or backup code. 2 attempts remaining.",
      );
    });

    it("should return lockout message when no tries remain", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);
      (verifyTOTPToken as jest.Mock).mockReturnValue(false);
      // incrementFailures returns 3 → triesLeft = 3 - 3 = 0
      (twoFactorRateLimiter.incrementFailures as jest.Mock).mockResolvedValue(
        3,
      );

      const result = await service.verifyWithdrawal2FA({ userId: "user-123" });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "Too many failed attempts. 2FA is now locked for 15 minutes.",
      );
    });
  });

  // ── updateMandatory2FAWithdrawals ─────────────────────────────────────────

  describe("updateMandatory2FAWithdrawals", () => {
    it("should successfully update preference when enabling", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);
      mockUserModel.updateMandatory2FAWithdrawals.mockResolvedValue(
        undefined as any,
      );

      await service.updateMandatory2FAWithdrawals("user-123", true);

      expect(mockUserModel.updateMandatory2FAWithdrawals).toHaveBeenCalledWith(
        "user-123",
        true,
      );
    });

    it("should throw error when enabling without 2FA enabled", async () => {
      const userWithout2FA = { ...mockUser, two_factor_enabled: false };
      mockUserModel.findById.mockResolvedValue(userWithout2FA as any);
      (is2FAEnabled as jest.Mock).mockReturnValue(false);

      await expect(
        service.updateMandatory2FAWithdrawals("user-123", true),
      ).rejects.toThrow(
        "Cannot enable mandatory 2FA withdrawals without 2FA being enabled",
      );
    });

    it("should allow disabling without performing a 2FA check", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);
      mockUserModel.updateMandatory2FAWithdrawals.mockResolvedValue(
        undefined as any,
      );

      await service.updateMandatory2FAWithdrawals("user-123", false);

      expect(mockUserModel.updateMandatory2FAWithdrawals).toHaveBeenCalledWith(
        "user-123",
        false,
      );
    });
  });

  // ── getWithdrawal2FASettings ──────────────────────────────────────────────

  describe("getWithdrawal2FASettings", () => {
    it("should return correct settings for user with 2FA enabled", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);
      (is2FAEnabled as jest.Mock).mockReturnValue(true);

      const result = await service.getWithdrawal2FASettings("user-123");

      expect(result).toEqual({
        mandatory2FAWithdrawals: true,
        has2FAEnabled: true,
        canEnableMandatory: true,
      });
    });

    it("should return correct settings for user without 2FA", async () => {
      const userWithout2FA = { ...mockUser, two_factor_enabled: false };
      mockUserModel.findById.mockResolvedValue(userWithout2FA as any);
      (is2FAEnabled as jest.Mock).mockReturnValue(false);

      const result = await service.getWithdrawal2FASettings("user-123");

      expect(result).toEqual({
        mandatory2FAWithdrawals: true,
        has2FAEnabled: false,
        canEnableMandatory: false,
      });
    });

    it("should throw when user is not found", async () => {
      mockUserModel.findById.mockResolvedValue(null);

      await expect(
        service.getWithdrawal2FASettings("user-123"),
      ).rejects.toThrow("User not found");
    });
  });

  // ── generateAndStoreBackupCodes ───────────────────────────────────────────

  describe("generateAndStoreBackupCodes", () => {
    it("should generate, hash, and store 10 codes and return them in plaintext", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);

      const result = await service.generateAndStoreBackupCodes("user-123");

      expect(result).toEqual(PLAINTEXT_CODES);
      expect(generateBackupCodes).toHaveBeenCalledTimes(1);
      expect(hashBackupCodes).toHaveBeenCalledWith(PLAINTEXT_CODES);
    });

    it("should run inside a transaction: BEGIN → DELETE → 10x INSERT → COMMIT", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);

      await service.generateAndStoreBackupCodes("user-123");

      const queryCalls = (mockClient.query as jest.Mock).mock.calls.map(
        (args: any[]) =>
          typeof args[0] === "string" ? args[0].trim() : args[0],
      );

      expect(queryCalls[0]).toBe("BEGIN");
      expect(queryCalls[1]).toBe("DELETE FROM backup_codes WHERE user_id = $1");

      for (let i = 2; i < 12; i++) {
        expect(queryCalls[i]).toBe(
          "INSERT INTO backup_codes (user_id, code_hash) VALUES ($1, $2)",
        );
      }

      expect(queryCalls[12]).toBe("COMMIT");
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it("should DELETE existing codes before inserting new ones", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);

      await service.generateAndStoreBackupCodes("user-123");

      const queryCalls = (mockClient.query as jest.Mock).mock.calls;
      // DELETE is the second call (index 1), INSERT starts at index 2
      const deleteCall = queryCalls[1] as any[];
      expect(deleteCall[0]).toBe("DELETE FROM backup_codes WHERE user_id = $1");
      expect(deleteCall[1]).toEqual(["user-123"]);
    });

    it("should pass the user id and each hash to the INSERT statement", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);

      await service.generateAndStoreBackupCodes("user-123");

      const queryCalls = (mockClient.query as jest.Mock).mock.calls;
      // INSERT calls start at index 2
      for (let i = 0; i < 10; i++) {
        const insertCall = queryCalls[i + 2] as any[];
        expect(insertCall[1]).toEqual(["user-123", HASHED_CODES[i]]);
      }
    });

    it("should throw when user is not found", async () => {
      mockUserModel.findById.mockResolvedValue(null);

      await expect(
        service.generateAndStoreBackupCodes("user-123"),
      ).rejects.toThrow("User not found");
    });

    it("should throw when 2FA setup has not been initiated (no secret)", async () => {
      mockUserModel.findById.mockResolvedValue({
        ...mockUser,
        two_factor_secret: null,
      } as any);

      await expect(
        service.generateAndStoreBackupCodes("user-123"),
      ).rejects.toThrow(
        "Cannot generate backup codes: 2FA setup not initiated",
      );
    });

    it("should ROLLBACK and rethrow when a DB error occurs during INSERT", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser as any);

      const dbError = new Error("DB write failed");
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // DELETE
        .mockRejectedValueOnce(dbError); // first INSERT fails

      await expect(
        service.generateAndStoreBackupCodes("user-123"),
      ).rejects.toThrow("DB write failed");

      const queryCalls = (mockClient.query as jest.Mock).mock.calls.map(
        (args: any[]) =>
          typeof args[0] === "string" ? args[0].trim() : args[0],
      );
      expect(queryCalls).toContain("ROLLBACK");
      // client must always be released
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
  });

  // ── getRemainingBackupCodeCount ───────────────────────────────────────────

  describe("getRemainingBackupCodeCount", () => {
    it("should return the count of unused backup codes as a number", async () => {
      mockClient.query.mockResolvedValue({ rows: [{ count: "7" }] });

      const count = await service.getRemainingBackupCodeCount("user-123");

      expect(count).toBe(7);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE user_id = $1 AND used = FALSE"),
        ["user-123"],
      );
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it("should return 0 when no unused codes remain", async () => {
      mockClient.query.mockResolvedValue({ rows: [{ count: "0" }] });

      const count = await service.getRemainingBackupCodeCount("user-123");

      expect(count).toBe(0);
    });

    it("should release the client and rethrow on a DB error", async () => {
      const dbError = new Error("Connection lost");
      mockClient.query.mockRejectedValue(dbError);

      await expect(
        service.getRemainingBackupCodeCount("user-123"),
      ).rejects.toThrow("Connection lost");

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
  });
});
