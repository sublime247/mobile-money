import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

export interface TOTPSecret {
  secret: string;
  qrCode: string;
  backupCodes: string[];
}

export interface BackupCode {
  id: string;
  code_hash: string;
  used: boolean;
  created_at: Date;
}

/**
 * Generate a new TOTP secret for a user
 * @param userEmail User's email for the TOTP issuer
 * @returns TOTP secret and QR code data
 */
export function generateTOTPSecret(userEmail: string): TOTPSecret {
  const secret = speakeasy.generateSecret({
    name: `Mobile Money (${userEmail})`,
    issuer: 'Mobile Money',
    length: 32
  });

  // Generate QR code
  const otpauthUrl = speakeasy.otpauthURL({
    secret: secret.base32,
    label: `Mobile Money (${userEmail})`,
    issuer: 'Mobile Money'
  });

  // Generate backup codes
  const backupCodes = generateBackupCodes();

  return {
    secret: secret.base32,
    qrCode: otpauthUrl,
    backupCodes
  };
}

/**
 * Convert QR code URL to base64 image
 * @param qrCodeUrl The OTPAuth URL for QR code
 * @returns Base64 encoded QR code image
 */
export async function generateQRCodeDataURL(qrCodeUrl: string): Promise<string> {
  try {
    return await QRCode.toDataURL(qrCodeUrl);
  } catch (error: unknown) {
    throw new Error('Failed to generate QR code', { cause: error });
  }
}

/**
 * Verify a TOTP token
 * @param secret The user's TOTP secret
 * @param token The token to verify
 * @param window Time window for verification (default: 2)
 * @returns True if token is valid
 */
export function verifyTOTPToken(secret: string, token: string, window: number = 2): boolean {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window
  });
}

/**
 * Generate 10 single-use backup codes
 * @returns Array of 10 backup codes
 */
export function generateBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    // Generate 8-character alphanumeric code
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
}

/**
 * Hash backup codes for storage
 * @param codes Array of backup codes
 * @returns Array of hashed backup codes
 */
export async function hashBackupCodes(codes: string[]): Promise<string[]> {
  const hashedCodes: string[] = [];
  
  for (const code of codes) {
    const hash = await bcrypt.hash(code, 10);
    hashedCodes.push(hash);
  }
  
  return hashedCodes;
}

/**
 * Verify a backup code against hashed codes
 * @param code The backup code to verify
 * @param hashedCodes Array of hashed backup codes
 * @returns True if code is valid and not used
 */
export async function verifyBackupCode(
  code: string, 
  hashedCodes: BackupCode[]
): Promise<{ valid: boolean; codeId?: string }> {
  for (const hashedCode of hashedCodes) {
    if (hashedCode.used) continue;
    
    const isValid = await bcrypt.compare(code, hashedCode.code_hash);
    if (isValid) {
      return { valid: true, codeId: hashedCode.id };
    }
  }
  
  return { valid: false };
}

/**
 * Check if user has 2FA enabled
 * @param user User object with 2FA fields
 * @returns True if 2FA is enabled
 */
interface TwoFactorUser {
  two_factor_secret?: string;
  two_factor_enabled?: boolean;
  two_factor_verified?: boolean;
}

export function is2FAEnabled(user: TwoFactorUser): boolean {
  return !!(
    user.two_factor_secret &&
    user.two_factor_enabled &&
    user.two_factor_verified
  );
}

/**
 * Validate TOTP setup token
 * @param secret The TOTP secret
 * @param token The token to validate
 * @returns True if token is valid for setup
 */
export function validateTOTPSetup(secret: string, token: string): boolean {
  return verifyTOTPToken(secret, token, 1); // Use smaller window for setup
}

/**
 * Generate a random backup code ID
 * @returns Random UUID string
 */
export function generateBackupCodeId(): string {
  return crypto.randomUUID();
}
