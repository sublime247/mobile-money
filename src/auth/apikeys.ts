import crypto from "crypto";

// ─── Permission Scope Definitions ────────────────────────────────────────────

/**
 * Issue #936: Granular API Key Scoping Matrix
 *
 * Scopes follow a `resource:action` convention, mirroring OAuth2 best practice.
 * Every scope is a single bit in a 32-bit integer bitmask, so combinations are
 * formed cheaply with bitwise OR:
 *
 *   TRANSACTIONS_READ | BALANCE_READ  →  a read-only reporting key
 *   DEPOSITS_INITIATE | DEPOSITS_READ →  a deposit-only integration key
 *
 * Scope groups (FULL_ACCESS, READ_ONLY, etc.) are pre-computed helpers for the
 * admin UI and for backward-compatible key creation.
 */
export const ApiKeyScope = {
  // ── Transactions ─────────────────────────────────────────────────────────
  /** Query transaction history, status, and receipts */
  TRANSACTIONS_READ:    0x00000001,
  /** Initiate new transactions (deposit / withdrawal initiation) */
  TRANSACTIONS_WRITE:   0x00000002,
  /** Void or refund an existing transaction */
  TRANSACTIONS_REFUND:  0x00000004,
  /** Export transaction data as CSV / PDF */
  TRANSACTIONS_EXPORT:  0x00000008,

  // ── Balance & Accounts ───────────────────────────────────────────────────
  /** Read account balances and statements */
  BALANCE_READ:         0x00000010,
  /** Trigger balance top-ups (e.g. manual liquidity injection) */
  BALANCE_WRITE:        0x00000020,

  // ── Deposits ─────────────────────────────────────────────────────────────
  /** Read deposit records */
  DEPOSITS_READ:        0x00000040,
  /** Initiate a mobile-money → Stellar deposit */
  DEPOSITS_INITIATE:    0x00000080,

  // ── Withdrawals ──────────────────────────────────────────────────────────
  /** Read withdrawal records */
  WITHDRAWALS_READ:     0x00000100,
  /** Initiate a Stellar → mobile-money withdrawal */
  WITHDRAWALS_INITIATE: 0x00000200,

  // ── Users & KYC ──────────────────────────────────────────────────────────
  /** Read user profiles (own) */
  USERS_READ:           0x00000400,
  /** Update user profile fields */
  USERS_WRITE:          0x00000800,
  /** Submit or review KYC documents */
  KYC_WRITE:            0x00001000,

  // ── Webhooks ─────────────────────────────────────────────────────────────
  /** List and inspect webhook subscriptions */
  WEBHOOKS_READ:        0x00002000,
  /** Create, update, or delete webhook endpoints */
  WEBHOOKS_WRITE:       0x00004000,

  // ── Exchange Rates ───────────────────────────────────────────────────────
  /** Read live and historical exchange rates */
  RATES_READ:           0x00008000,

  // ── Reporting & Analytics ────────────────────────────────────────────────
  /** Access reporting / analytics dashboards */
  REPORTS_READ:         0x00010000,

  // ── Admin ────────────────────────────────────────────────────────────────
  /** Manage other API keys (create / revoke / list) */
  KEYS_MANAGE:          0x00020000,
  /** System-level admin operations (user management, config) */
  ADMIN:                0x00040000,
} as const;

export type ApiKeyScopeName = keyof typeof ApiKeyScope;
export type ApiKeyScopeValue = (typeof ApiKeyScope)[ApiKeyScopeName];

// ─── Pre-composed Scope Groups ────────────────────────────────────────────────

/**
 * Convenience bundles.  Each is the bitwise OR of the constituent scopes so
 * consumers can write  `permissions: ScopeGroup.READ_ONLY`  instead of
 * manually combining bits.
 */
export const ScopeGroup = {
  /** All permissions – used for backward-compatible "root" keys */
  FULL_ACCESS: Object.values(ApiKeyScope).reduce((a, b) => a | b, 0),

  /** Read-only reporting integration */
  READ_ONLY:
    ApiKeyScope.TRANSACTIONS_READ |
    ApiKeyScope.TRANSACTIONS_EXPORT |
    ApiKeyScope.BALANCE_READ |
    ApiKeyScope.DEPOSITS_READ |
    ApiKeyScope.WITHDRAWALS_READ |
    ApiKeyScope.USERS_READ |
    ApiKeyScope.RATES_READ |
    ApiKeyScope.REPORTS_READ,

  /** Deposit-only partner integration */
  DEPOSIT_ONLY:
    ApiKeyScope.DEPOSITS_READ |
    ApiKeyScope.DEPOSITS_INITIATE |
    ApiKeyScope.TRANSACTIONS_READ |
    ApiKeyScope.BALANCE_READ,

  /** Withdrawal-only partner integration */
  WITHDRAWAL_ONLY:
    ApiKeyScope.WITHDRAWALS_READ |
    ApiKeyScope.WITHDRAWALS_INITIATE |
    ApiKeyScope.TRANSACTIONS_READ |
    ApiKeyScope.BALANCE_READ,

  /** Webhook management (CI/CD pipeline key) */
  WEBHOOKS_ONLY:
    ApiKeyScope.WEBHOOKS_READ |
    ApiKeyScope.WEBHOOKS_WRITE,

  /** Key management – allows creating / revoking child keys */
  KEY_ADMIN:
    ApiKeyScope.KEYS_MANAGE |
    ApiKeyScope.TRANSACTIONS_READ |
    ApiKeyScope.BALANCE_READ,
} as const;

// ─── Scope Sets (resource -> scope name arrays) ──────────────────────────────

/**
 * Resource-oriented arrays of scope names. Useful for rendering admin UI
 * checklists and for programmatic validation when creating keys from the UI.
 */
export const ScopeSets = {
  TRANSACTIONS: [
    "TRANSACTIONS_READ",
    "TRANSACTIONS_WRITE",
    "TRANSACTIONS_REFUND",
    "TRANSACTIONS_EXPORT",
  ] as ApiKeyScopeName[],

  BALANCE: ["BALANCE_READ", "BALANCE_WRITE"] as ApiKeyScopeName[],

  DEPOSITS: ["DEPOSITS_READ", "DEPOSITS_INITIATE"] as ApiKeyScopeName[],

  WITHDRAWALS: ["WITHDRAWALS_READ", "WITHDRAWALS_INITIATE"] as ApiKeyScopeName[],

  USERS: ["USERS_READ", "USERS_WRITE", "KYC_WRITE"] as ApiKeyScopeName[],

  WEBHOOKS: ["WEBHOOKS_READ", "WEBHOOKS_WRITE"] as ApiKeyScopeName[],

  RATES: ["RATES_READ"] as ApiKeyScopeName[],

  REPORTS: ["REPORTS_READ"] as ApiKeyScopeName[],

  ADMIN: ["KEYS_MANAGE", "ADMIN"] as ApiKeyScopeName[],
} as const;

/** Return all available scope names (ordered as defined). */
export function listAllScopeNames(): ApiKeyScopeName[] {
  return Object.keys(ApiKeyScope) as ApiKeyScopeName[];
}

// ─── Time-of-Day Window ───────────────────────────────────────────────────────

export interface TimeWindow {
  /** UTC hour (0–23), inclusive */
  startHour: number;
  /** UTC hour (0–23), inclusive */
  endHour: number;
}

// ─── Core ApiKey Interface ────────────────────────────────────────────────────

export interface ApiKey {
  /** The raw secret value (shown only once at creation) */
  key: string;
  createdAt: Date;
  expiresAt: Date;
  isActive: boolean;

  /**
   * Bitmask of granted permission scopes.
   * Defaults to ScopeGroup.FULL_ACCESS for backward compatibility.
   */
  permissions: number;

  /** Explicit list of allowed scope names – kept in sync with permissions bitmask */
  scopes: ApiKeyScopeName[];

  /** Human-readable label for the key management UI */
  label?: string;

  /**
   * Optional UTC time-of-day window during which the key is valid.
   * Requests outside this window receive 403 even with a valid key.
   * Omit to allow 24/7 access.
   */
  allowedTimeWindow?: TimeWindow;

  /**
   * Optional list of allowed IP CIDR ranges (e.g. "192.168.1.0/24").
   * If present, requests from IPs outside all listed CIDRs are rejected.
   */
  allowedIpCidrs?: string[];

  /**
   * Optional list of HTTP method + path prefix pairs this key may access,
   * e.g. [{ method: "POST", pathPrefix: "/api/transactions" }].
   * Omit to allow all routes (subject to scope checks).
   */
  allowedRoutes?: Array<{ method: string; pathPrefix: string }>;
}

// ─── Factory & Helpers ────────────────────────────────────────────────────────

export function generateApiKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

export interface CreateApiKeyOptions {
  /** Bitmask OR named scope array – one must be supplied */
  permissions?: number;
  scopes?: ApiKeyScopeName[];
  label?: string;
  /** Days until expiry (default: 30) */
  expiresInDays?: number;
  allowedTimeWindow?: TimeWindow;
  allowedIpCidrs?: string[];
  allowedRoutes?: Array<{ method: string; pathPrefix: string }>;
}

/**
 * Build an ApiKey object and push it onto the user's key list.
 * Accepts either a raw bitmask or an array of scope names; if both are
 * provided the bitmask takes precedence.
 */
export function createApiKey(
  user: { apiKeys?: ApiKey[] },
  options: CreateApiKeyOptions = {},
): ApiKey {
  if (!user.apiKeys) user.apiKeys = [];

  const permissions = resolvePermissions(options);
  const scopes = describeScopes(permissions);

  const newKey: ApiKey = {
    key: generateApiKey(),
    createdAt: new Date(),
    expiresAt: new Date(
      Date.now() + (options.expiresInDays ?? 30) * 24 * 60 * 60 * 1000,
    ),
    isActive: true,
    permissions,
    scopes,
    label: options.label,
    allowedTimeWindow: options.allowedTimeWindow,
    allowedIpCidrs: options.allowedIpCidrs,
    allowedRoutes: options.allowedRoutes,
  };

  user.apiKeys.push(newKey);
  return newKey;
}

export function validateApiKey(
  user: { apiKeys?: ApiKey[] },
  key: string,
): ApiKey | null {
  if (!user.apiKeys) return null;

  return (
    user.apiKeys.find(
      (k) => k.key === key && k.isActive && new Date(k.expiresAt) > new Date(),
    ) ?? null
  );
}

/**
 * Check whether an ApiKey carries a specific scope bit.
 *
 * @example
 *   if (!hasScope(apiKey, ApiKeyScope.DEPOSITS_INITIATE)) {
 *     return res.status(403).json({ error: "Insufficient scope" });
 *   }
 */
export function hasScope(apiKey: ApiKey, scope: ApiKeyScopeValue): boolean {
  return (apiKey.permissions & scope) === scope;
}

/**
 * Check whether an ApiKey carries ALL of the listed scopes.
 */
export function hasAllScopes(
  apiKey: ApiKey,
  ...scopes: ApiKeyScopeValue[]
): boolean {
  return scopes.every((s) => hasScope(apiKey, s));
}

/**
 * Check whether an ApiKey carries ANY of the listed scopes.
 */
export function hasAnyScope(
  apiKey: ApiKey,
  ...scopes: ApiKeyScopeValue[]
): boolean {
  return scopes.some((s) => hasScope(apiKey, s));
}

/**
 * Return the human-readable names of all scopes set in a bitmask.
 */
export function describeScopes(permissions: number): ApiKeyScopeName[] {
  return (Object.keys(ApiKeyScope) as ApiKeyScopeName[]).filter(
    (name) => (permissions & ApiKeyScope[name]) === ApiKeyScope[name],
  );
}

/**
 * Return a full human-readable scope matrix for display in an admin UI.
 * Useful for debugging or rendering a key-detail page.
 */
export function buildScopeMatrix(
  permissions: number,
): Array<{ scope: ApiKeyScopeName; bit: number; granted: boolean }> {
  return (Object.keys(ApiKeyScope) as ApiKeyScopeName[]).map((name) => ({
    scope: name,
    bit: ApiKeyScope[name],
    granted: (permissions & ApiKeyScope[name]) === ApiKeyScope[name],
  }));
}

/**
 * Validate that a time-window definition is well-formed.
 */
export function validateTimeWindow(tw: TimeWindow): string | null {
  if (tw.startHour < 0 || tw.startHour > 23)
    return "startHour must be between 0 and 23";
  if (tw.endHour < 0 || tw.endHour > 23)
    return "endHour must be between 0 and 23";
  if (tw.startHour === tw.endHour)
    return "startHour and endHour must differ";
  return null;
}

/**
 * Rotate a key while preserving all scoping constraints from the source key.
 */
export function rotateApiKey(
  user: { apiKeys?: ApiKey[] },
  sourceKey?: ApiKey,
): ApiKey {
  if (!user.apiKeys) user.apiKeys = [];

  const newKey: ApiKey = {
    key: generateApiKey(),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    isActive: true,
    permissions: sourceKey?.permissions ?? ScopeGroup.FULL_ACCESS,
    scopes: sourceKey?.scopes ?? describeScopes(ScopeGroup.FULL_ACCESS),
    label: sourceKey?.label,
    allowedTimeWindow: sourceKey?.allowedTimeWindow,
    allowedIpCidrs: sourceKey?.allowedIpCidrs,
    allowedRoutes: sourceKey?.allowedRoutes,
  };

  user.apiKeys.push(newKey);
  return newKey;
}

// ─── Legacy Compat ────────────────────────────────────────────────────────────

/**
 * @deprecated Use `hasScope(apiKey, ApiKeyScope.*)` instead.
 * Kept for backward compatibility with Issue #518 callers.
 */
export const ApiKeyPermission = {
  READ:     ApiKeyScope.TRANSACTIONS_READ,
  DEPOSIT:  ApiKeyScope.DEPOSITS_INITIATE,
  WITHDRAW: ApiKeyScope.WITHDRAWALS_INITIATE,
  ADMIN:    ApiKeyScope.ADMIN,
  ALL:      ScopeGroup.FULL_ACCESS,
} as const;

/** @deprecated Use `hasScope` */
export function hasPermission(apiKey: ApiKey, permission: number): boolean {
  return (apiKey.permissions & permission) === permission;
}

/** @deprecated Use `describeScopes` */
export function describePermissions(permissions: number): string[] {
  return describeScopes(permissions);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function resolvePermissions(options: CreateApiKeyOptions): number {
  if (options.permissions !== undefined) return options.permissions;
  if (options.scopes && options.scopes.length > 0) {
    return options.scopes.reduce(
      (acc, name) => acc | ApiKeyScope[name],
      0,
    );
  }
  return ScopeGroup.FULL_ACCESS;
}