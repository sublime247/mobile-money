import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  checkDeviceVerification,
  generateVerificationOTP,
  verifyOTP,
  setVerificationPending,
  clearVerificationPending,
  getPendingVerificationId,
  isVerificationPending,
} from "../deviceVerification";

// Mock Redis
jest.mock("../../config/redis", () => ({
  redisClient: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    incr: jest.fn(),
    isOpen: true,
  },
}));

describe("Device Verification Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("checkDeviceVerification", () => {
    it("should require verification for new device", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get.mockResolvedValue(null);
      redisClient.set.mockResolvedValue("OK");

      const result = await checkDeviceVerification("user-123", "192.168.1.1", "fingerprint-abc");

      expect(result.requiresVerification).toBe(true);
      expect(result.verificationId).toBeDefined();
      expect(result.reason).toBe("new_device");
      expect(result.isNewDevice).toBe(true);
    });

    it("should require verification for new IP", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get
        .mockResolvedValueOnce("trusted") // device is known
        .mockResolvedValueOnce(null); // IP is new
      redisClient.set.mockResolvedValue("OK");

      const result = await checkDeviceVerification("user-123", "192.168.1.1", "fingerprint-abc");

      expect(result.requiresVerification).toBe(true);
      expect(result.reason).toBe("new_ip");
      expect(result.isNewIp).toBe(true);
    });

    it("should not require verification for known device and IP", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get.mockResolvedValue("trusted");

      const result = await checkDeviceVerification("user-123", "192.168.1.1", "fingerprint-abc");

      expect(result.requiresVerification).toBe(false);
      expect(result.verificationId).toBeUndefined();
    });

    it("should handle Redis errors gracefully", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get.mockRejectedValue(new Error("Redis error"));

      const result = await checkDeviceVerification("user-123", "192.168.1.1", "fingerprint-abc");

      expect(result.requiresVerification).toBe(false);
    });
  });

  describe("generateVerificationOTP", () => {
    it("should generate 6-digit OTP", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get.mockResolvedValue(JSON.stringify({
        userId: "user-123",
        ipAddress: "192.168.1.1",
        fingerprint: "fingerprint-abc",
      }));
      redisClient.set.mockResolvedValue("OK");

      const otp = await generateVerificationOTP("verification-id-123");

      expect(otp).toBeDefined();
      expect(otp).toHaveLength(6);
      expect(/^\d{6}$/.test(otp)).toBe(true);
    });

    it("should return null for invalid verification ID", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get.mockResolvedValue(null);

      const otp = await generateVerificationOTP("invalid-id");

      expect(otp).toBeNull();
    });

    it("should handle Redis errors gracefully", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get.mockRejectedValue(new Error("Redis error"));

      const otp = await generateVerificationOTP("verification-id-123");

      expect(otp).toBeNull();
    });
  });

  describe("verifyOTP", () => {
    it("should verify correct OTP and trust device/IP", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get
        .mockResolvedValueOnce(JSON.stringify({
          userId: "user-123",
          ipAddress: "192.168.1.1",
          fingerprint: "fingerprint-abc",
        })) // verification data
        .mockResolvedValueOnce("0") // attempts
        .mockResolvedValueOnce("123456"); // stored OTP
      redisClient.del.mockResolvedValue(1);
      redisClient.set.mockResolvedValue("OK");

      const result = await verifyOTP("verification-id-123", "123456");

      expect(result.success).toBe(true);
      expect(result.message).toBe("Verification successful");
      expect(redisClient.set).toHaveBeenCalledTimes(2); // device and IP trust
    });

    it("should reject incorrect OTP", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get
        .mockResolvedValueOnce(JSON.stringify({
          userId: "user-123",
          ipAddress: "192.168.1.1",
          fingerprint: "fingerprint-abc",
        }))
        .mockResolvedValueOnce("0")
        .mockResolvedValueOnce("123456");
      redisClient.incr.mockResolvedValue(1);

      const result = await verifyOTP("verification-id-123", "000000");

      expect(result.success).toBe(false);
      expect(result.message).toContain("Invalid verification code");
      expect(redisClient.incr).toHaveBeenCalled();
    });

    it("should block after max attempts", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get
        .mockResolvedValueOnce(JSON.stringify({
          userId: "user-123",
          ipAddress: "192.168.1.1",
          fingerprint: "fingerprint-abc",
        }))
        .mockResolvedValueOnce("3"); // max attempts reached
      redisClient.del.mockResolvedValue(1);

      const result = await verifyOTP("verification-id-123", "123456");

      expect(result.success).toBe(false);
      expect(result.message).toContain("Maximum verification attempts exceeded");
    });

    it("should handle expired OTP", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get
        .mockResolvedValueOnce(JSON.stringify({
          userId: "user-123",
          ipAddress: "192.168.1.1",
          fingerprint: "fingerprint-abc",
        }))
        .mockResolvedValueOnce("0")
        .mockResolvedValueOnce(null); // OTP expired
      redisClient.del.mockResolvedValue(1);

      const result = await verifyOTP("verification-id-123", "123456");

      expect(result.success).toBe(false);
      expect(result.message).toContain("expired");
    });
  });

  describe("verification pending state", () => {
    it("should set verification pending", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.set.mockResolvedValue("OK");

      await setVerificationPending("user-123", "verification-id-123");

      expect(redisClient.set).toHaveBeenCalledWith(
        "user:user-123:pending_verification",
        "verification-id-123",
        { EX: 600 }
      );
    });

    it("should clear verification pending", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.del.mockResolvedValue(1);

      await clearVerificationPending("user-123");

      expect(redisClient.del).toHaveBeenCalledWith("user:user-123:pending_verification");
    });

    it("should check if verification is pending", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get.mockResolvedValue("verification-id-123");

      const isPending = await isVerificationPending("user-123");

      expect(isPending).toBe(true);
      expect(redisClient.get).toHaveBeenCalledWith("user:user-123:pending_verification");
    });

    it("should return false when verification is not pending", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get.mockResolvedValue(null);

      const isPending = await isVerificationPending("user-123");

      expect(isPending).toBe(false);
    });

    it("should get pending verification ID", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get.mockResolvedValue("verification-id-123");

      const verificationId = await getPendingVerificationId("user-123");

      expect(verificationId).toBe("verification-id-123");
    });

    it("should return null when no pending verification", async () => {
      const { redisClient } = require("../../config/redis");
      redisClient.get.mockResolvedValue(null);

      const verificationId = await getPendingVerificationId("user-123");

      expect(verificationId).toBeNull();
    });
  });
});
