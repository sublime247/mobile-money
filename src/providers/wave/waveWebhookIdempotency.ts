/**
 * Wave Senegal webhook idempotency (issue #2328).
 *
 * Wave can deliver the same `checkout.session.completed` event more than once
 * during network blips. Every delivery is signed, so a duplicate cannot be
 * distinguished from a fresh event by the signature alone; the checkout
 * session id is the stable provider identifier.
 *
 * The guard atomically claims `wave:webhook:{checkout_session_id}` with Redis
 * `SET NX EX 86400`. The first delivery owns the claim, processes the event,
 * and records a `processed` status. Any duplicate delivery gets an immediate
 * HTTP 200 without re-running the crediting logic.
 */

import { redisClient } from "../../config/redis";
import logger from "../../utils/logger";

/** Webhook idempotency keys are retained for 24 hours. */
export const WAVE_WEBHOOK_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export const WAVE_WEBHOOK_IDEMPOTENCY_PREFIX = "wave:webhook";

export type WaveWebhookIdempotencyStatus = "processing" | "processed";

interface WaveWebhookIdempotencyRecord {
  status: WaveWebhookIdempotencyStatus;
  eventId?: string;
  clientReference?: string;
  receivedAt: string;
  processedAt?: string;
}

export interface WaveWebhookIdempotencyResult {
  acquired: boolean;
  key: string;
  status: WaveWebhookIdempotencyStatus;
  complete: () => Promise<void>;
  release: () => Promise<void>;
}

interface RedisIdempotencyClient {
  set(
    key: string,
    value: string,
    options: { NX?: boolean; EX?: number },
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

interface FallbackEntry {
  value: string;
  expiresAt: number;
}

const fallbackStore = new Map<string, FallbackEntry>();

function getFallback(key: string): string | null {
  const entry = fallbackStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    fallbackStore.delete(key);
    return null;
  }
  return entry.value;
}

function setFallback(key: string, value: string): void {
  fallbackStore.set(key, {
    value,
    expiresAt: Date.now() + WAVE_WEBHOOK_IDEMPOTENCY_TTL_SECONDS * 1000,
  });
}

function deleteFallback(key: string): void {
  fallbackStore.delete(key);
}

/** Test/tooling helper; production keys expire naturally. */
export function clearWaveWebhookIdempotencyFallback(): void {
  fallbackStore.clear();
}

export function buildWaveWebhookIdempotencyKey(
  checkoutSessionId: string,
): string {
  return `${WAVE_WEBHOOK_IDEMPOTENCY_PREFIX}:${checkoutSessionId.trim()}`;
}

function parseRecord(raw: string | null): WaveWebhookIdempotencyRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WaveWebhookIdempotencyRecord;
  } catch {
    return null;
  }
}

/**
 * Atomically claim a Wave checkout session id. Returns `acquired: false` when
 * another delivery already owns the key (in-flight or processed).
 */
export async function acquireWaveWebhookIdempotency(
  checkoutSessionId: string,
  context: { eventId?: string; clientReference?: string } = {},
): Promise<WaveWebhookIdempotencyResult> {
  const key = buildWaveWebhookIdempotencyKey(checkoutSessionId);
  const record: WaveWebhookIdempotencyRecord = {
    status: "processing",
    eventId: context.eventId,
    clientReference: context.clientReference,
    receivedAt: new Date().toISOString(),
  };

  const client = redisClient as unknown as RedisIdempotencyClient;
  let acquired = false;

  try {
    const reply = await client.set(key, JSON.stringify(record), {
      NX: true,
      EX: WAVE_WEBHOOK_IDEMPOTENCY_TTL_SECONDS,
    });
    acquired = reply === "OK";
  } catch (error) {
    // Preserve single-process idempotency if Redis is unavailable. The
    // database claim in the handler remains the final double-credit guard.
    logger.error(
      { error, key },
      "[wave-webhook] Redis unavailable; using in-memory idempotency fallback",
    );
    if (!getFallback(key)) {
      setFallback(key, JSON.stringify(record));
      acquired = true;
    }
  }

  if (!acquired) {
    let status: WaveWebhookIdempotencyStatus = "processing";
    try {
      const existing = parseRecord(await client.get(key));
      if (existing?.status) status = existing.status;
    } catch {
      status = "processing";
    }

    return {
      acquired: false,
      key,
      status,
      complete: async () => undefined,
      release: async () => undefined,
    };
  }

  const expire = async () => {
    try {
      await client.set(
        key,
        JSON.stringify({
          ...record,
          status: "processed",
          processedAt: new Date().toISOString(),
        } satisfies WaveWebhookIdempotencyRecord),
        { EX: WAVE_WEBHOOK_IDEMPOTENCY_TTL_SECONDS },
      );
    } catch {
      setFallback(
        key,
        JSON.stringify({
          ...record,
          status: "processed",
          processedAt: new Date().toISOString(),
        }),
      );
    }
  };

  const release = async () => {
    try {
      await client.del(key);
    } catch {
      deleteFallback(key);
    }
    deleteFallback(key);
  };

  return {
    acquired: true,
    key,
    status: "processing",
    complete: expire,
    release,
  };
}
