/**
 * Device Verification OTP Service
 *
 * When a login originates from an unrecognised IP or device fingerprint,
 * this service suspends full session access and gates it behind a
 * short-lived OTP delivered via email or SMS.
 *
 * Flow:
 *   1. Auth middleware detects new IP / fingerprint (see fingerprint.ts)
 *   2. Calls DeviceOtpService.issueChallenge() -> stores OTP in Redis (TTL 10 min)
 *   3. Returns 403 + challenge token to the client
 *   4. Client submits OTP via POST /auth/verify-device
 *   5. Calls DeviceOtpService.verify() -> deletes key + marks session trusted
 */

import crypto from 'crypto';
import { redisClient } from '../config/redis';
import logger from '../utils/logger';

const OTP_LENGTH   = 6;           // digits
const OTP_TTL_SECS = 10 * 60;    // 10 minutes
const MAX_ATTEMPTS = 5;           // lockout after N wrong attempts

// Redis key namespaces
const KEY_OTP      = (userId: string) => `device-otp:${userId}:code`;
const KEY_ATTEMPTS = (userId: string) => `device-otp:${userId}:attempts`;
const KEY_TRUSTED  = (userId: string, fp: string) => `device-otp:${userId}:trusted:${fp}`;

export interface OtpChallenge {
  /** Opaque token the client must return with the OTP (ties submission to user) */
  challengeToken: string;
  /** TTL in seconds */
  expiresIn: number;
  /** Channel the OTP was sent on */
  channel: 'email' | 'sms';
}

export interface VerifyResult {
  valid: boolean;
  reason?: 'INVALID_CODE' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS';
}

/**
 * Generate a cryptographically random numeric OTP.
 */
function generateOtp(): string {
  const bytes  = crypto.randomBytes(4);
  const number = bytes.readUInt32BE(0);
  return String(number % Math.pow(10, OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

/**
 * Hash the OTP before storing so a Redis dump does not leak codes.
 */
function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

export class DeviceOtpService {
  /**
   * Issue a new OTP challenge for a user logging in from an unrecognised device.
   *
   * The OTP is stored hashed in Redis with a TTL. The plaintext code is passed
   * to the provided notifier function (email / SMS abstraction).
   *
   * @param userId    Authenticated user ID
   * @param notifier  Async function that sends the plaintext OTP to the user
   * @param channel   Channel label returned to the client
   */
  async issueChallenge(
    userId: string,
    notifier: (otp: string) => Promise<void>,
    channel: 'email' | 'sms' = 'email',
  ): Promise<OtpChallenge> {
    const otp   = generateOtp();
    const hashed = hashOtp(otp);

    // Store hashed OTP with TTL
    await (redisClient as any).set(KEY_OTP(userId), hashed, { EX: OTP_TTL_SECS });
    // Reset attempt counter
    await (redisClient as any).del(KEY_ATTEMPTS(userId));

    // Deliver plaintext OTP via injected notifier
    await notifier(otp);

    logger.info({ userId, channel }, '[device-otp] OTP challenge issued');

    return {
      challengeToken: Buffer.from(userId).toString('base64url'),
      expiresIn: OTP_TTL_SECS,
      channel,
    };
  }

  /**
   * Verify the OTP a user submitted.
   *
   * On success the OTP key is deleted (single-use) and the device fingerprint
   * is marked trusted for a rolling 30-day window.
   *
   * @param userId      Authenticated user ID
   * @param otp         Plaintext code submitted by the user
   * @param fingerprint Device fingerprint (hashed) to mark as trusted on success
   */
  async verify(
    userId: string,
    otp: string,
    fingerprint?: string,
  ): Promise<VerifyResult> {
    // Check attempt count first
    const attemptsRaw = await (redisClient as any).get(KEY_ATTEMPTS(userId));
    const attempts    = attemptsRaw ? parseInt(attemptsRaw, 10) : 0;

    if (attempts >= MAX_ATTEMPTS) {
      logger.warn({ userId }, '[device-otp] Too many failed attempts');
      return { valid: false, reason: 'TOO_MANY_ATTEMPTS' };
    }

    const stored = await (redisClient as any).get(KEY_OTP(userId));
    if (!stored) {
      return { valid: false, reason: 'EXPIRED' };
    }

    const expected = hashOtp(otp);
    if (stored !== expected) {
      // Increment failed attempt counter with same TTL as the OTP
      await (redisClient as any).set(
        KEY_ATTEMPTS(userId),
        String(attempts + 1),
        { EX: OTP_TTL_SECS },
      );
      logger.warn({ userId }, '[device-otp] Invalid OTP submitted');
      return { valid: false, reason: 'INVALID_CODE' };
    }

    // Valid — clean up and mark device trusted
    await (redisClient as any).del(KEY_OTP(userId));
    await (redisClient as any).del(KEY_ATTEMPTS(userId));

    if (fingerprint) {
      await (redisClient as any).set(
        KEY_TRUSTED(userId, fingerprint),
        '1',
        { EX: 30 * 24 * 60 * 60 },  // 30 days
      );
    }

    logger.info({ userId }, '[device-otp] OTP verified successfully');
    return { valid: true };
  }

  /**
   * Check whether a fingerprint has been previously verified for this user.
   * Returns true if the device is trusted (skip OTP), false otherwise.
   */
  async isTrustedDevice(userId: string, fingerprint: string): Promise<boolean> {
    const val = await (redisClient as any).get(KEY_TRUSTED(userId, fingerprint));
    return val === '1';
  }
}

export const deviceOtpService = new DeviceOtpService();
