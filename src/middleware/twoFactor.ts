import { Request, Response, NextFunction } from "express";
import {
  verifyTOTPToken,
  verifyBackupCode,
  is2FAEnabled,
  type BackupCode,
} from "../auth/2fa";
import {
  twoFactorRateLimiter,
  type TwoFactorRateLimitHeaders,
} from "../services/twoFactorRateLimiter";
// import { getUserById } from "../services/userService";

function applyTwoFactorRateLimitHeaders(
  res: Response,
  headers: TwoFactorRateLimitHeaders,
): void {
  res.setHeader("X-RateLimit-Limit", String(headers.limit));
  res.setHeader("X-RateLimit-Remaining", String(headers.remaining));
  res.setHeader("X-RateLimit-Reset", headers.resetAt);
  res.setHeader("Retry-After", String(headers.retryAfter));
}

/**
 * Middleware to require 2FA verification for sensitive operations
 * Checks for TOTP token in header or backup code in body
 */
export function requireTwoFactor(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  return async (
    err: any,
    _req: Request,
    _res: Response,
    _next: NextFunction,
  ) => {
    if (err) return next(err);

    if (!req.jwtUser) {
      return res.status(401).json({
        error: "Authentication required",
        message: "Valid JWT token required",
      });
    }

    try {
      // Use user object from res.locals (populated by attachUserObject middleware)
      const user = res.locals.user;
      if (!user) {
        return res.status(404).json({
          error: "User not found",
          message: "User associated with token no longer exists",
        });
      }

      // Check if 2FA is enabled for this user
      if (!is2FAEnabled(user)) {
        // If 2FA is not enabled, allow the operation
        req.twoFactorVerified = true;
        return next();
      }

      // Check for TOTP token in headers
      const totpToken = req.headers["x-2fa-token"] as string;
      const backupCode = req.body["backupCode"] || req.body["backup_code"];

      if (totpToken || (backupCode && user.backup_codes)) {
        // 1. Check if user is locked
        if (await twoFactorRateLimiter.isLocked(user.id)) {
          const headers = await twoFactorRateLimiter.getRateLimitHeaders(
            user.id,
          );
          applyTwoFactorRateLimitHeaders(res, headers);

          return res.status(429).json({
            error: "2FA locked",
            message: "Too many failed 2FA attempts. Please try again later.",
            lockoutSeconds: headers.retryAfter,
          });
        }

        // 2. Try TOTP token
        if (totpToken) {
          const isValid = verifyTOTPToken(user.two_factor_secret!, totpToken);
          if (isValid) {
            await twoFactorRateLimiter.resetFailures(user.id);
            req.twoFactorVerified = true;
            return next();
          }
        }

        // 3. Try backup code
        if (backupCode && user.backup_codes) {
          const verification = await verifyBackupCode(
            backupCode,
            user.backup_codes as unknown as BackupCode[],
          );
          if (verification.valid) {
            await twoFactorRateLimiter.resetFailures(user.id);
            req.twoFactorVerified = true;
            return next();
          }
        }

        // 4. Verification failed - increment count
        const newCount = await twoFactorRateLimiter.incrementFailures(user.id);
        const triesLeft = Math.max(0, 3 - newCount);
        const headers = await twoFactorRateLimiter.getRateLimitHeaders(user.id);
        applyTwoFactorRateLimitHeaders(res, headers);

        return res.status(403).json({
          error: "Invalid 2FA",
          message:
            triesLeft > 0
              ? `Invalid 2FA token or backup code. ${triesLeft} attempts remaining.`
              : "Too many failed attempts. 2FA is now locked for 15 minutes.",
          triesRemaining: triesLeft,
        });
      }

      // If we reach here, 2FA verification failed
      const headers = await twoFactorRateLimiter.getRateLimitHeaders(user.id);
      applyTwoFactorRateLimitHeaders(res, headers);

      return res.status(403).json({
        error: "Two-factor authentication required",
        message: "This operation requires two-factor authentication",
        required: true,
        methods: {
          totp: "Provide TOTP token in X-2FA-Token header",
          backupCode:
            "Provide backup code in request body as backupCode or backup_code",
        },
      });
    } catch (error) {
      return res.status(500).json({
        error: "2FA verification failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}

/**
 * Middleware to check if 2FA is verified
 * Used after requireTwoFactor to ensure verification was successful
 */
export function ensureTwoFactorVerified(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.twoFactorVerified) {
    return next();
  }

  return res.status(403).json({
    error: "Two-factor authentication not verified",
    message: "This operation requires verified two-factor authentication",
  });
}

/**
 * Middleware to optionally require 2FA
 * Allows operation to proceed if 2FA is not enabled, but requires it if enabled
 */
export function optionalTwoFactor(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  return async (
    err: any,
    _req: Request,
    _res: Response,
    _next: NextFunction,
  ) => {
    if (err) return next(err);

    if (!req.jwtUser) {
      return res.status(401).json({
        error: "Authentication required",
        message: "Valid JWT token required",
      });
    }

    try {
      // Use user object from res.locals (populated by attachUserObject middleware)
      const user = res.locals.user;
      if (!user) {
        return res.status(404).json({
          error: "User not found",
          message: "User associated with token no longer exists",
        });
      }

      // If 2FA is not enabled, allow the operation
      if (!is2FAEnabled(user)) {
        req.twoFactorVerified = true;
        return next();
      }

      // If 2FA is enabled, check for verification
      const totpToken = req.headers["x-2fa-token"] as string;
      const backupCode = req.body["backupCode"] || req.body["backup_code"];

      if (totpToken || (backupCode && user.backup_codes)) {
        // Check if locked
        if (await twoFactorRateLimiter.isLocked(user.id)) {
          req.twoFactorVerified = false;
          return next();
        }

        // Try TOTP
        if (totpToken) {
          const isValid = verifyTOTPToken(user.two_factor_secret!, totpToken);
          if (isValid) {
            await twoFactorRateLimiter.resetFailures(user.id);
            req.twoFactorVerified = true;
            return next();
          }
        }

        // Try backup code
        if (backupCode && user.backup_codes) {
          const verification = await verifyBackupCode(
            backupCode,
            user.backup_codes as unknown as BackupCode[],
          );
          if (verification.valid) {
            await twoFactorRateLimiter.resetFailures(user.id);
            req.twoFactorVerified = true;
            return next();
          }
        }

        // Failed attempt
        await twoFactorRateLimiter.incrementFailures(user.id);
      }

      // If 2FA is enabled but not verified, still allow operation with warning
      // This is for operations that are sensitive but not critical
      req.twoFactorVerified = false;
      return next();
    } catch (error) {
      return res.status(500).json({
        error: "2FA check failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}
