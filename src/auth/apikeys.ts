import crypto from "crypto";

/**
 * API Key Permission Bitmask (Issue #518)
 * Enables granular, least-privilege access control for partner API keys.
 *
 * Each permission is a single bit, allowing combinations via bitwise OR:
 *   READ | DEPOSIT = 0x03  →  can read data and initiate deposits
 */
export enum ApiKeyPermission {
  /** Query transactions, reports, balances */
  READ = 0x01,
  /** Initiate deposit (mobile money → Stellar) */
  DEPOSIT = 0x02,
  /** Initiate withdrawal (Stellar → mobile money) */
  WITHDRAW = 0x04,
  /** Administrative operations (user management, config) */
  ADMIN = 0x08,
  /** All permissions (backward-compatible default) */
  ALL = 0x0f,
}

export interface ApiKey {
  key: string;
  createdAt: Date;
  expiresAt: Date;
  isActive: boolean;
  /** Bitmask of granted permissions (default: ALL = 0x0F) */
  permissions: number;
  /** Human-readable label for key management UI */
  label?: string;
}

// Generate secure API key
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

// Create a new API key with optional scoped permissions
export function createApiKey(
  user: any,
  options?: { permissions?: number; label?: string },
): ApiKey {
  if (!user.apiKeys) {
    user.apiKeys = [];
  }

  const newKey: ApiKey = {
    key: generateApiKey(),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    isActive: true,
    permissions: options?.permissions ?? ApiKeyPermission.ALL,
    label: options?.label,
  };

  user.apiKeys.push(newKey);
  return newKey;
}

// Validate API key
export function validateApiKey(user: any, key: string): ApiKey | null {
  if (!user.apiKeys) return null;

  const validKey = user.apiKeys.find(
    (k: ApiKey) =>
      k.key === key && k.isActive && new Date(k.expiresAt) > new Date(),
  );

  return validKey || null;
}

/**
 * Check whether an API key has a specific permission bit set.
 * Usage: hasPermission(apiKey, ApiKeyPermission.DEPOSIT)
 */
export function hasPermission(apiKey: ApiKey, permission: number): boolean {
  return (apiKey.permissions & permission) === permission;
}

/**
 * Return a human-readable list of permission names for an API key.
 */
export function describePermissions(permissions: number): string[] {
  const names: string[] = [];
  if (permissions & ApiKeyPermission.READ) names.push("read");
  if (permissions & ApiKeyPermission.DEPOSIT) names.push("deposit");
  if (permissions & ApiKeyPermission.WITHDRAW) names.push("withdraw");
  if (permissions & ApiKeyPermission.ADMIN) names.push("admin");
  return names;
}

// Rotate API key (no downtime) — carries forward permissions from the newest active key
export function rotateApiKey(user: any, sourceKey?: ApiKey): ApiKey {
  if (!user.apiKeys) {
    user.apiKeys = [];
  }

  // Inherit permissions from source key if provided, otherwise default to ALL
  const inheritedPermissions = sourceKey?.permissions ?? ApiKeyPermission.ALL;

  const newKey: ApiKey = {
    key: generateApiKey(),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    isActive: true,
    permissions: inheritedPermissions,
    label: sourceKey?.label,
  };

  // IMPORTANT: keep old keys active
  user.apiKeys.push(newKey);

  return newKey;
}
