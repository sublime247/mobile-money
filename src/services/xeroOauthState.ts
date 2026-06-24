import { redisClient } from "../config/redis";

/**
 * Xero OAuth 2.0 "state" store.
 *
 * The Xero authorization callback (`GET /api/accounting/xero/callback`) is a
 * browser redirect originating from Xero. It therefore cannot carry the
 * application's `Authorization` header / API key, so we cannot rely on the
 * normal `requireAuth` middleware to know *which* user started the flow.
 *
 * To bridge this gap we generate a cryptographically-unique `state` value when
 * the user initiates the flow (`GET /api/accounting/xero/auth`) and persist a
 * mapping of `state -> userId`. When Xero redirects back we look the `state`
 * up again to (a) defend against CSRF and (b) re-associate the callback with
 * the originating user.
 *
 * Redis is used when available (multi-instance safe). When Redis is not
 * connected we transparently fall back to an in-memory map so local
 * development and unit tests keep working.
 */

const STATE_TTL_SECONDS = 60 * 10; // 10 minutes
const REDIS_KEY_PREFIX = "xero:oauth:state:";

interface XeroOAuthStateRecord {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

const memoryStore = new Map<string, XeroOAuthStateRecord>();

function redisKey(state: string): string {
  return `${REDIS_KEY_PREFIX}${state}`;
}

function isRedisAvailable(): boolean {
  try {
    return Boolean(redisClient && (redisClient as { isOpen?: boolean }).isOpen);
  } catch {
    return false;
  }
}

/**
 * Persist a `state -> userId` mapping for the duration of an OAuth handshake.
 */
export async function saveXeroOAuthState(
  state: string,
  userId: string,
): Promise<void> {
  const now = Date.now();
  const record: XeroOAuthStateRecord = {
    userId,
    createdAt: now,
    expiresAt: now + STATE_TTL_SECONDS * 1000,
  };

  if (isRedisAvailable()) {
    await redisClient.set(redisKey(state), JSON.stringify(record), {
      EX: STATE_TTL_SECONDS,
    });
    return;
  }

  memoryStore.set(state, record);
}

/**
 * Atomically read & delete a previously stored `state`, returning the bound
 * `userId`. Returns `null` when the state is unknown or expired. Consuming the
 * value guarantees a `state` can only be used once (replay protection).
 */
export async function consumeXeroOAuthState(
  state: string,
): Promise<string | null> {
  if (!state) {
    return null;
  }

  if (isRedisAvailable()) {
    const key = redisKey(state);
    const raw = await redisClient.get(key);
    if (!raw) {
      return null;
    }
    await redisClient.del(key);
    try {
      const rawStr = typeof raw === "string" ? raw : raw.toString();
      const record = JSON.parse(rawStr) as XeroOAuthStateRecord;
      return record.expiresAt > Date.now() ? record.userId : null;
    } catch {
      return null;
    }
  }

  const record = memoryStore.get(state);
  memoryStore.delete(state);
  if (!record) {
    return null;
  }
  return record.expiresAt > Date.now() ? record.userId : null;
}

/**
 * Test/maintenance helper — clears the in-memory fallback store.
 */
export function __clearXeroOAuthStateMemoryStore(): void {
  memoryStore.clear();
}
