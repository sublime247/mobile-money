import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { Request, Response } from "express";
import { TwoFactorWithdrawalController } from "../twoFactorWithdrawalController";
import { TwoFactorWithdrawalService } from "../../services/twoFactorWithdrawalService";

// Mock dependencies
jest.mock("../../services/twoFactorWithdrawalService");

describe("TwoFactorWithdrawalController", () => {
  let controller: TwoFactorWithdrawalController;
  let mockService: jest.Mocked<TwoFactorWithdrawalService>;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockService =
      new TwoFactorWithdrawalService() as jest.Mocked<TwoFactorWithdrawalService>;
    controller = new TwoFactorWithdrawalController();
    (controller as any).twoFactorWithdrawalService = mockService;

    mockRequest = {
      user: { id: "user-123" },
      body: {},
    };

    mockResponse = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    mockNext = jest.fn();
  });

  describe("getWithdrawal2FASettings", () => {
    it("should return 2FA withdrawal settings", async () => {
      const mockSettings = {
        mandatory2FAWithdrawals: true,
        has2FAEnabled: true,
        canEnableMandatory: true,
      };

      mockService.getWithdrawal2FASettings.mockResolvedValue(mockSettings);

      await controller.getWithdrawal2FASettings(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockService.getWithdrawal2FASettings).toHaveBeenCalledWith(
        "user-123",
      );
      expect(mockResponse.json).toHaveBeenCalledWith(mockSettings);
    });

    it("should handle errors", async () => {
      const error = new Error("Service error");
      mockService.getWithdrawal2FASettings.mockRejectedValue(error);

      await controller.getWithdrawal2FASettings(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe("updateMandatory2FAWithdrawals", () => {
    it("should update mandatory 2FA withdrawals setting", async () => {
      mockRequest.body = { enabled: true };
      mockService.updateMandatory2FAWithdrawals.mockResolvedValue();

      await controller.updateMandatory2FAWithdrawals(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockService.updateMandatory2FAWithdrawals).toHaveBeenCalledWith(
        "user-123",
        true,
      );
      expect(mockResponse.json).toHaveBeenCalledWith({
        message: "Mandatory 2FA withdrawals updated successfully",
      });
    });

    it("should handle errors", async () => {
      mockRequest.body = { enabled: true };
      const error = new Error("Service error");
      mockService.updateMandatory2FAWithdrawals.mockRejectedValue(error);

      await controller.updateMandatory2FAWithdrawals(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });
});
