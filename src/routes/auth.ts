import { Router, Request, Response } from 'express';
import { generateToken, verifyToken, JWTPayload, generateRefreshToken, verifyRefreshToken } from '../auth/jwt';
import { createSSORouter } from '../auth/sso';
import { enforceSSOForEmployees } from '../middleware/ssoEnforcement';
import { tokenController } from '../controllers/tokenController';
import { authenticateToken } from '../middleware/auth';
import { authenticateUser, getUserByPhoneNumber, getUserPermissions } from '../services/userService';
import { getLockoutStatus, recordFailedAttempt, recordSuccessfulLogin } from '../auth/lockout';
import { EmailService } from '../services/email';

export const authRoutes = Router();
const emailService = new EmailService();

// Mount SSO routes
authRoutes.use('/sso', createSSORouter());

/**
 * POST /api/auth/login
 * 
 * Example login endpoint that generates a JWT token
 * In a real application, this would validate user credentials against a database
 */
authRoutes.post('/login', async (req: Request, res: Response) => {
  const { phone_number } = req.body;

  if (!phone_number) {
    return res.status(400).json({
      error: 'Missing required fields',
      message: 'phone_number is required',
    });
  }

  try {
    const identifier = String(phone_number).trim();
    const currentLockout = await getLockoutStatus(identifier);

    if (currentLockout.isLocked) {
      return res.status(423).json({
        error: 'Account locked',
        message: `Too many failed login attempts. Try again in ${currentLockout.minutesRemaining} minute${currentLockout.minutesRemaining === 1 ? '' : 's'}.`,
      });
    }

    const user = await authenticateUser(identifier);

    if (!user) {
      const lockoutResult = await recordFailedAttempt(identifier);

      if (lockoutResult.justLocked) {
        const existingUser = await getUserByPhoneNumber(identifier);
        if (existingUser?.email) {
          await emailService.sendAccountLockoutNotice(
            existingUser.email,
            lockoutResult.minutesRemaining || 10,
          );
        }
      }

      return res.status(lockoutResult.isLocked ? 423 : 401).json({
        error: lockoutResult.isLocked ? 'Account locked' : 'Unauthorized',
        message: lockoutResult.message,
      });
    }

    await recordSuccessfulLogin(identifier);

    const payload = {
      userId: user.id,
      email: user.phone_number,
      role: user.role_name || 'user',
    };

    const token = generateToken(payload);
    const refreshToken = await generateRefreshToken(user.id);
    const permissions = await getUserPermissions(user.id);

    res.json({
      message: 'Login successful',
      token,
      refreshToken,
      user: {
        userId: user.id,
        email: user.phone_number,
        role: user.role_name || 'user',
        permissions,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: 'Token generation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/auth/refresh
 *
 * Rotates refresh token, issues new access and refresh tokens, and enforces strict rotation
 */
authRoutes.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({
      error: 'Missing refresh token',
      message: 'Refresh token is required'
    });
  }
  try {
    // Verify and check for reuse
    const decoded = await verifyRefreshToken(refreshToken);
    // Issue new access and refresh tokens (rotate)
    const token = generateToken({ userId: decoded.userId, email: '' }); // You may want to fetch email if needed
    const newRefreshToken = await generateRefreshToken(decoded.userId, decoded.familyId, decoded.tokenId);
    res.json({
      message: 'Token rotation successful',
      token,
      refreshToken: newRefreshToken
    });
  } catch (error) {
    res.status(401).json({
      error: 'Refresh failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/auth/tokens
 *
 * List all active refresh token
 */
authRoutes.get("/tokens/active/:family_id", authenticateToken, tokenController.findAll);

/**
 * DELETE /api/auth/tokens
 *
 * Delete all refresh token
 */ 
authRoutes.delete("/tokens/revoke-all/:family_id", authenticateToken, tokenController.revokeAll);

/**
 * DELETE /api/auth/tokens
 *
 * Delete a specific refresh token
 */ 
authRoutes.delete("/tokens/:token_id/:family_id", authenticateToken, tokenController.revoke);

/**
 * POST /api/auth/verify
 * 
 * Verify a JWT token and return the decoded payload
 */
authRoutes.post('/verify', (req: Request, res: Response) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({
      error: 'Missing token',
      message: 'Token is required for verification'
    });
  }

  try {
    const payload = verifyToken(token);
    res.json({
      valid: true,
      payload
    });
  } catch (error) {
    res.status(401).json({
      valid: false,
      error: 'Token verification failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/auth/me
 * 
 * Protected route that returns current user information
 * Requires valid JWT token in Authorization header
 */
authRoutes.get('/me', authenticateToken, async (req: Request, res: Response) => {
  const payload = req.jwtUser as JWTPayload;

  if (!payload) {
    return res.status(401).json({
      error: 'Access denied',
      message: 'No token provided',
    });
  }

  try {
    const permissions = await getUserPermissions(payload.userId);

    res.json({
      user: {
        userId: payload.userId,
        email: payload.email,
        role: payload.role,
        permissions,
      },
      tokenInfo: {
        issuedAt: payload.iat,
        expiresAt: payload.exp,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: 'Unable to fetch user info',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
