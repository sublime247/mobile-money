import crypto from "crypto";
import logger from "../utils/logger";

/**
 * JWT key rotation store (issue #1971).
 *
 * Supports zero-downtime secret rotation:
 * - New tokens are always signed with the current *primary* (active) key.
 * - Incoming tokens are verified against both the primary key and any
 *   *secondary* keys that are still inside their grace window.
 * - Secondary keys are automatically deprecated once the configurable
 *   grace window (JWT_KEY_GRACE_PERIOD_HOURS, default 24h) has elapsed
 *   since the key was rotated out of primary duty.
 */

interface KeyEntry {
  version: string;
  key: string;
  /** Epoch ms when this entry was created. */
  createdAt: number;
  /** Epoch ms when this entry stopped being the primary signing key (0 = still primary). */
  rotatedOutAt: number;
}

const DEFAULT_ACTIVE_VERSION = "v1";

/** Grace window in ms. Configurable via JWT_KEY_GRACE_PERIOD_HOURS (default 24h). */
export const GRACE_PERIOD_MS = (() => {
  const hours = Number.parseFloat(
    process.env.JWT_KEY_GRACE_PERIOD_HOURS || "24",
  );
  if (!Number.isFinite(hours) || hours < 0) {
    return 24 * 60 * 60 * 1000;
  }
  return hours * 60 * 60 * 1000;
})();

let keyStore: Map<string, KeyEntry> = new Map();
let activeVersion: string = DEFAULT_ACTIVE_VERSION;

function initFromEnv(): void {
  keyStore.clear();

  const secretsRaw = process.env.JWT_SECRETS;
  if (secretsRaw) {
    try {
      const parsed: Record<string, string> = JSON.parse(secretsRaw);
      for (const [version, key] of Object.entries(parsed)) {
        keyStore.set(version, {
          version,
          key,
          createdAt: Date.now(),
          rotatedOutAt: 0,
        });
      }
    } catch {
      logger.warn("[jwtKeys] Failed to parse JWT_SECRETS JSON");
    }
  }

  const legacy = process.env.JWT_SECRET;
  if (legacy && !keyStore.has(DEFAULT_ACTIVE_VERSION)) {
    keyStore.set(DEFAULT_ACTIVE_VERSION, {
      version: DEFAULT_ACTIVE_VERSION,
      key: legacy,
      createdAt: Date.now(),
      rotatedOutAt: 0,
    });
  }

  activeVersion = process.env.ACTIVE_JWT_KEY_VERSION || DEFAULT_ACTIVE_VERSION;
  if (!keyStore.has(activeVersion)) {
    activeVersion = DEFAULT_ACTIVE_VERSION;
  }

  if (keyStore.size === 0) {
    const initialKey = crypto.randomBytes(32).toString("hex");
    keyStore.set(DEFAULT_ACTIVE_VERSION, {
      version: DEFAULT_ACTIVE_VERSION,
      key: initialKey,
      createdAt: Date.now(),
      rotatedOutAt: 0,
    });
    activeVersion = DEFAULT_ACTIVE_VERSION;
    logger.warn(
      { version: DEFAULT_ACTIVE_VERSION },
      "[jwtKeys] No JWT secrets found — generated ephemeral signing key",
    );
  }
}

/**
 * Removes every secondary key that has exhausted its grace window.
 * Returns the versions removed.
 */
export function deprecateExpiredKeys(now: number = Date.now()): string[] {
  if (keyStore.size === 0) {
    initFromEnv();
  }

  const expired: string[] = [];
  for (const [version, entry] of keyStore) {
    if (version === activeVersion) continue;
    // Keys rotated out at time T remain valid until T + GRACE_PERIOD_MS.
    const deprecationTime = entry.rotatedOutAt || entry.createdAt;
    if (now - deprecationTime >= GRACE_PERIOD_MS) {
      expired.push(version);
    }
  }

  for (const version of expired) {
    keyStore.delete(version);
    logger.info(
      { version },
      "[jwtKeys] Secondary key deprecation complete — key no longer accepted for verification",
    );
  }

  return expired;
}

/** Returns the current primary signing key and its key id. */
export function getActiveSigningKey(): { key: string; kid: string } {
  if (keyStore.size === 0) {
    initFromEnv();
  }
  const entry = keyStore.get(activeVersion);
  if (!entry) {
    throw new Error(
      `Active JWT key version "${activeVersion}" not found in key store`,
    );
  }
  return { key: entry.key, kid: entry.version };
}

/**
 * Returns all keys that may be used to verify incoming tokens:
 * the primary key first, followed by secondary keys still inside the
 * grace window. Older secrets are automatically excluded once the
 * grace period lapses.
 */
export function getVerificationKeys(): { key: string; kid: string }[] {
  if (keyStore.size === 0) {
    initFromEnv();
  }

  // Opportunistic cleanup: lazily deprecate keys whose grace window ended.
  deprecateExpiredKeys();

  const results: { key: string; kid: string }[] = [];
  for (const [version, entry] of keyStore) {
    if (version === activeVersion) {
      results.push({ key: entry.key, kid: version });
      continue;
    }
    // Secondary (grace) key: valid only within the grace window.
    const deprecationTime = entry.rotatedOutAt || entry.createdAt;
    if (Date.now() - deprecationTime < GRACE_PERIOD_MS) {
      results.push({ key: entry.key, kid: version });
    }
  }

  if (results.length === 0) {
    throw new Error("No JWT verification keys available");
  }

  // Primary first so the common case verifies on the first attempt.
  results.sort((a, b) => {
    const aIsActive = a.kid === activeVersion ? 1 : 0;
    const bIsActive = b.kid === activeVersion ? 1 : 0;
    return bIsActive - aIsActive;
  });

  return results;
}

/**
 * Rotates the signing key:
 * 1. The previous primary becomes a secondary key, retained for the
 *    grace window so in-flight tokens keep verifying.
 * 2. A new primary key is generated and used for all new tokens.
 * 3. Any secondary keys that have exhausted their grace window are
 *    automatically deprecated.
 */
export async function rotateKey(): Promise<{ oldKid: string; newKid: string }> {
  if (keyStore.size === 0) {
    initFromEnv();
  }

  const newVersionNum =
    Math.max(
      0,
      ...Array.from(keyStore.keys()).map((v) => {
        const n = parseInt(v.replace(/^v/i, ""), 10);
        return isNaN(n) ? 0 : n;
      }),
    ) + 1;
  const newVersion = `v${newVersionNum}`;
  const newKey = crypto.randomBytes(32).toString("hex");

  const oldKid = activeVersion;
  const now = Date.now();

  // Demote the previous primary into the grace window (now secondary).
  const previous = keyStore.get(oldKid);
  if (previous) {
    previous.rotatedOutAt = now;
    keyStore.set(oldKid, previous);
  }

  keyStore.set(newVersion, {
    version: newVersion,
    key: newKey,
    createdAt: now,
    rotatedOutAt: 0,
  });
  activeVersion = newVersion;

  const staleKeys = deprecateExpiredKeys(now);

  logger.warn(
    {
      oldKid,
      newKid: activeVersion,
      staleKeysRemoved: staleKeys.length,
      activeKeysRemaining: keyStore.size,
      gracePeriodMs: GRACE_PERIOD_MS,
    },
    "[JWT-KeyRotation] JWT signing key rotated — previous key remains valid for the grace window",
  );

  return { oldKid, newKid: activeVersion };
}

/**
 * Restores the primary role of `version` (used by tests and the manual
 * rotation scheduler rollback path).
 */
export function setActiveVersion(version: string): void {
  if (keyStore.size === 0) {
    initFromEnv();
  }
  if (!keyStore.has(version)) {
    throw new Error(`Unknown JWT key version "${version}"`);
  }
  activeVersion = version;
}

export function resetStore(): void {
  keyStore.clear();
  activeVersion = DEFAULT_ACTIVE_VERSION;
}

initFromEnv();
