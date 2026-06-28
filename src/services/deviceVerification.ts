import { redisClient } from "../config/redis";
import logger from "../utils/logger";
import { randomBytes } from "crypto";

export interface DeviceVerificationResult {
  requiresVerification: boolean;
  verificationId?: string;
  reason?: "new_device" | "new_ip" | "suspicious_activity";
  isNewDevice?: boolean;
  isNewIp?: boolean;
}

export interface VerifyOTPResult {
  success: boolean;
  message?: string;
}

const VERIFICATION_TTL_SECONDS = 10 * 60; // 10 minutes
const MAX_ATTEMPTS = 3;
const OTP_LENGTH = 6;

const VERIFICATION_KEY_PREFIX = "device_verification:";
const ATTEMPTS_KEY_PREFIX = "verification_attempts:";

/**
 * Generate a numeric OTP code
 */
function generateOTP(): string {
  const digits = "0123456789";
  let otp = "";
  for (let i = 0; i < OTP_LENGTH; i++) {
    otp += digits[Math.floor(Math.random() * digits.length)];
  }
  return otp;
}

/**
 * Generate a unique verification ID
 */
function generateVerificationId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Check if a device/IP combination requires verification
 */
export async function checkDeviceVerification(
  userId: string,
  ipAddress: string,
  fingerprint: string,
): Promise<DeviceVerificationResult> {
  try {
    // Check if this device fingerprint has been seen before
    const deviceKey = `user:${userId}:device:${fingerprint}`;
    const knownDevice = await redisClient.get(deviceKey);
    
    // Check if this IP has been seen before
    const ipKey = `user:${userId}:ip:${ipAddress}`;
    const knownIp = await redisClient.get(ipKey);
    
    const isNewDevice = !knownDevice;
    const isNewIp = !knownIp;
    
    // Require verification if either device or IP is new
    const requiresVerification = isNewDevice || isNewIp;
    
    if (requiresVerification) {
      const verificationId = generateVerificationId();
      
      // Store verification requirement
      const verificationKey = `${VERIFICATION_KEY_PREFIX}${verificationId}`;
      await redisClient.set(verificationKey, JSON.stringify({
        userId,
        ipAddress,
        fingerprint,
        isNewDevice,
        isNewIp,
        createdAt: Date.now(),
      }), {
        EX: VERIFICATION_TTL_SECONDS,
      });
      
      // Initialize attempts counter
      const attemptsKey = `${ATTEMPTS_KEY_PREFIX}${verificationId}`;
      await redisClient.set(attemptsKey, "0", {
        EX: VERIFICATION_TTL_SECONDS,
      });
      
      logger.info({
        userId,
        verificationId,
        isNewDevice,
        isNewIp,
        ipAddress,
      }, "Device verification required");
      
      return {
        requiresVerification: true,
        verificationId,
        reason: isNewDevice ? "new_device" : "new_ip",
        isNewDevice,
        isNewIp,
      };
    }
    
    return {
      requiresVerification: false,
    };
  } catch (error) {
    logger.error({ error, userId }, "Error checking device verification");
    // On error, allow login without verification to prevent blocking legitimate users
    return {
      requiresVerification: false,
    };
  }
}

/**
 * Generate and store OTP code for device verification
 */
export async function generateVerificationOTP(
  verificationId: string,
): Promise<string | null> {
  try {
    const verificationKey = `${VERIFICATION_KEY_PREFIX}${verificationId}`;
    const verificationData = await redisClient.get(verificationKey);
    
    if (!verificationData) {
      logger.warn({ verificationId }, "Verification ID not found or expired");
      return null;
    }
    
    const otp = generateOTP();
    const otpKey = `${VERIFICATION_KEY_PREFIX}${verificationId}:otp`;
    
    await redisClient.set(otpKey, otp, {
      EX: VERIFICATION_TTL_SECONDS,
    });
    
    logger.info({
      verificationId,
      otpLength: otp.length,
    }, "Verification OTP generated");
    
    return otp;
  } catch (error) {
    logger.error({ error, verificationId }, "Error generating verification OTP");
    return null;
  }
}

/**
 * Verify OTP code and release session
 */
export async function verifyOTP(
  verificationId: string,
  otp: string,
): Promise<VerifyOTPResult> {
  try {
    const verificationKey = `${VERIFICATION_KEY_PREFIX}${verificationId}`;
    const otpKey = `${VERIFICATION_KEY_PREFIX}${verificationId}:otp`;
    const attemptsKey = `${ATTEMPTS_KEY_PREFIX}${verificationId}`;
    
    // Check attempts
    const attemptsRaw = await redisClient.get(attemptsKey);
    const attempts = attemptsRaw ? parseInt(attemptsRaw, 10) : 0;
    
    if (attempts >= MAX_ATTEMPTS) {
      await redisClient.del(verificationKey, otpKey, attemptsKey);
      return {
        success: false,
        message: "Maximum verification attempts exceeded",
      };
    }
    
    // Get stored OTP
    const storedOtp = await redisClient.get(otpKey);
    
    if (!storedOtp) {
      return {
        success: false,
        message: "Verification code expired or invalid",
      };
    }
    
    // Verify OTP
    if (storedOtp !== otp) {
      // Increment attempts
      await redisClient.incr(attemptsKey);
      const remainingAttempts = MAX_ATTEMPTS - attempts - 1;
      
      logger.warn({
        verificationId,
        attempts: attempts + 1,
        remainingAttempts,
      }, "Invalid OTP attempt");
      
      return {
        success: false,
        message: `Invalid verification code. ${remainingAttempts} attempts remaining.`,
      };
    }
    
    // OTP is correct - get verification data and trust the device/IP
    const verificationDataRaw = await redisClient.get(verificationKey);
    if (verificationDataRaw) {
      const verificationData = JSON.parse(verificationDataRaw);
      
      // Trust this device
      const deviceKey = `user:${verificationData.userId}:device:${verificationData.fingerprint}`;
      await redisClient.set(deviceKey, "trusted", {
        EX: 30 * 24 * 60 * 60, // 30 days
      });
      
      // Trust this IP
      const ipKey = `user:${verificationData.userId}:ip:${verificationData.ipAddress}`;
      await redisClient.set(ipKey, "trusted", {
        EX: 30 * 24 * 60 * 60, // 30 days
      });
      
      logger.info({
        userId: verificationData.userId,
        verificationId,
        ipAddress: verificationData.ipAddress,
      }, "Device verification successful - device and IP trusted");
    }
    
    // Clean up verification data
    await redisClient.del(verificationKey, otpKey, attemptsKey);
    
    return {
      success: true,
      message: "Verification successful",
    };
  } catch (error) {
    logger.error({ error, verificationId }, "Error verifying OTP");
    return {
      success: false,
      message: "Verification failed due to server error",
    };
  }
}

/**
 * Check if a verification is still pending for a user
 */
export async function isVerificationPending(userId: string): Promise<boolean> {
  try {
    // This would typically be checked via session state
    // For now, we'll implement a simple check
    const pendingKey = `user:${userId}:pending_verification`;
    const pending = await redisClient.get(pendingKey);
    return pending !== null;
  } catch (error) {
    logger.error({ error, userId }, "Error checking verification status");
    return false;
  }
}

/**
 * Mark verification as pending for a user
 */
export async function setVerificationPending(
  userId: string,
  verificationId: string,
): Promise<void> {
  try {
    const pendingKey = `user:${userId}:pending_verification`;
    await redisClient.set(pendingKey, verificationId, {
      EX: VERIFICATION_TTL_SECONDS,
    });
  } catch (error) {
    logger.error({ error, userId }, "Error setting verification pending");
  }
}

/**
 * Clear pending verification for a user
 */
export async function clearVerificationPending(userId: string): Promise<void> {
  try {
    const pendingKey = `user:${userId}:pending_verification`;
    await redisClient.del(pendingKey);
  } catch (error) {
    logger.error({ error, userId }, "Error clearing verification pending");
  }
}

/**
 * Get pending verification ID for a user
 */
export async function getPendingVerificationId(userId: string): Promise<string | null> {
  try {
    const pendingKey = `user:${userId}:pending_verification`;
    const verificationId = await redisClient.get(pendingKey);
    return verificationId ? String(verificationId) : null;
  } catch (error) {
    logger.error({ error, userId }, "Error getting pending verification ID");
    return null;
  }
}
