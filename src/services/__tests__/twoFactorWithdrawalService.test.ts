import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { TwoFactorWithdrawalService } from "../twoFactorWithdrawalService";
import { UserModel } from "../../models/users";
import { is2FAEnabled, verifyTOTPToken } from "../../auth/2fa";

// Mock dependencies
jest.mock("../../models/users");
jest.mock("../../auth/2fa");
jest.mock("../../config/database");
jest.mock("../../utils/logger");

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
    mockUserModel = new UserModel() as jest.Mocked<UserModel>;
    service = new TwoFactorWithdrawalService();
    (service as any).userModel = mockUserModel;
  });

  describe("requires2FAForWithdrawal", () => {
    it("should return true when user has mandatory 2FA withdrawals enabled", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser);

      const result = await service.requires2FAForWithdrawal("user-123");

      expect(result).toBe(true);
      expect(mockUserModel.findById).toHaveBeenCalledWith("user-123");
    });

    it("should return false when user has mandatory 2FA withdrawals disabled", async () => {
      mockUserModel.findById.mockResolvedValue(mockUserWithoutMandatory);

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

  describe("verifyWithdrawal2FA", () => {
    beforeEach(() => {
      (is2FAEnabled as jest.Mock).mockReturnValue(true);
      (verifyTOTPToken as jest.Mock).mockReturnValue(true);
    });

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
      mockUserModel.findById.mockResolvedValue(mockUser);
      (is2FAEnabled as jest.Mock).mockReturnValue(false);

      const result = await service.verifyWithdrawal2FA({
        userId: "user-123",
        token: "123456",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("2FA not enabled for user");
    });

    it("should return error when mandatory 2FA withdrawals not enabled", async () => {
      mockUserModel.findById.mockResolvedValue(mockUserWithoutMandatory);

      const result = await service.verifyWithdrawal2FA({
        userId: "user-123",
        token: "123456",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "User has not opted into mandatory 2FA withdrawals",
      );
    });

    it("should successfully verify with TOTP token", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser);

      const result = await service.verifyWithdrawal2FA({
        userId: "user-123",
        token: "123456",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("totp");
    });

    it("should successfully verify with backup code", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser);
      (verifyTOTPToken as jest.Mock).mockReturnValue(false);

      // Mock backup code verification
      const mockPool = {
        connect: jest.fn().mockResolvedValue({
          query: jest.fn().mockResolvedValue({
            rows: [
              {
                id: "backup-123",
                code_hash: "$2b$10$hashedcode",
              },
            ],
          }),
          release: jest.fn(),
        }),
      };

      jest.doMock("../../config/database", () => ({
        pool: mockPool,
      }));

      // Mock bcrypt compare
      jest.doMock("bcrypt", () => ({
        compare: jest.fn().mockResolvedValue(true),
      }));

      const result = await service.verifyWithdrawal2FA({
        userId: "user-123",
        backupCode: "ABC123DEF",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("backup");
    });

    it("should return error when neither token nor backup code provided", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser);

      const result = await service.verifyWithdrawal2FA({
        userId: "user-123",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid 2FA token or backup code");
    });
  });

  describe("updateMandatory2FAWithdrawals", () => {
    it("should successfully update preference when enabling", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser);
      mockUserModel.updateMandatory2FAWithdrawals.mockResolvedValue();

      await service.updateMandatory2FAWithdrawals("user-123", true);

      expect(mockUserModel.updateMandatory2FAWithdrawals).toHaveBeenCalledWith(
        "user-123",
        true,
      );
    });

    it("should throw error when enabling without 2FA enabled", async () => {
      const userWithout2FA = { ...mockUser, two_factor_enabled: false };
      mockUserModel.findById.mockResolvedValue(userWithout2FA);
      (is2FAEnabled as jest.Mock).mockReturnValue(false);

      await expect(
        service.updateMandatory2FAWithdrawals("user-123", true),
      ).rejects.toThrow(
        "Cannot enable mandatory 2FA withdrawals without 2FA being enabled",
      );
    });

    it("should allow disabling without 2FA check", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser);
      mockUserModel.updateMandatory2FAWithdrawals.mockResolvedValue();

      await service.updateMandatory2FAWithdrawals("user-123", false);

      expect(mockUserModel.updateMandatory2FAWithdrawals).toHaveBeenCalledWith(
        "user-123",
        false,
      );
    });
  });

  describe("getWithdrawal2FASettings", () => {
    it("should return correct settings for user with 2FA enabled", async () => {
      mockUserModel.findById.mockResolvedValue(mockUser);
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
      mockUserModel.findById.mockResolvedValue(userWithout2FA);
      (is2FAEnabled as jest.Mock).mockReturnValue(false);

      const result = await service.getWithdrawal2FASettings("user-123");

      expect(result).toEqual({
        mandatory2FAWithdrawals: true,
        has2FAEnabled: false,
        canEnableMandatory: false,
      });
    });
  });
});
