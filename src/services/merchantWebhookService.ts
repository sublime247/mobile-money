import { createHmac } from "crypto";
import {
  MerchantWebhookModel,
  MerchantWebhook,
  WebhookDeliveryLog,
} from "../models/merchantWebhook";
import { SAMPLE_WEBHOOK_PAYLOAD } from "../routes/webhooks";
import { WebhookCacheInvalidation } from "./cacheAside";
import { signWebhookPayload } from "../crypto/webhookSigning";
import { validateWebhookUrl, SsrfBlockedError } from "../security/ssrf";
import { createWebhookSignature } from "../utils/webhookSigner";
import { context, propagation } from "@opentelemetry/api";

const model = new MerchantWebhookModel();

const DEFAULT_TIMEOUT_MS = 10_000;

interface DeliveryResult {
  status: "delivered" | "failed";
  httpStatus?: number;
  responseBody?: string;
  errorMessage?: string;
  /** Set for failures that retrying can never fix (e.g. SSRF rejections). */
  permanent?: boolean;
  durationMs: number;
}

interface MerchantWebhookServiceOptions {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Sign a payload for delivery. Uses Ed25519 (`ed25519=<hex>`) when
 * `WEBHOOK_ED25519_SIGNING_KEY` is configured, otherwise falls back to
 * HMAC-SHA256 (`sha256=<hex>`) using the merchant's own webhook secret —
 * same scheme as the platform-wide WebhookService.
 */
function signPayload(payload: string, secret: string): string {
  return signWebhookPayload(
    payload,
    (p) => "sha256=" + createHmac("sha256", secret).update(p).digest("hex"),
    process.env.WEBHOOK_ED25519_SIGNING_KEY,
  ).signature;
}

function isTransientFailure(result: DeliveryResult): boolean {
  if (result.permanent) return false;
  if (result.httpStatus === undefined) return true;
  return (
    result.httpStatus === 408 ||
    result.httpStatus === 429 ||
    result.httpStatus >= 500
  );
}

/**
 * Deliver a single webhook payload to the given URL.
 * Returns a structured result regardless of success/failure.
 * The destination is re-validated immediately before the request so a URL
 * that was safe at registration time (or that predates this guard) can never
 * be used to reach a private address.
 */
async function deliver(
  url: string,
  secret: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const start = Date.now();
  try {
    await validateWebhookUrl(url);
  } catch (err: unknown) {
    const errorMessage =
      err instanceof SsrfBlockedError ? err.message : String(err);
    return { status: "failed", errorMessage, permanent: true, durationMs: 0 };
  }

  const body = JSON.stringify(payload);
  const signature = signPayload(body, secret);
  const momoHeaders = createWebhookSignature(body, secret);
  const traceCarrier: Record<string, string> = {};
  propagation.inject(context.active(), traceCarrier);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          ...momoHeaders,
          ...traceCarrier,
          "User-Agent": "MobileMoney-Webhook/1.0",
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - start;
    const responseBody = await response.text().catch(() => "");

    if (response.ok) {
      return {
        status: "delivered",
        httpStatus: response.status,
        responseBody,
        durationMs,
      };
    }
    return {
      status: "failed",
      httpStatus: response.status,
      responseBody,
      errorMessage: `HTTP ${response.status}`,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const errorMessage =
      err instanceof Error
        ? err.name === "AbortError"
          ? `Timeout after ${DEFAULT_TIMEOUT_MS}ms`
          : err.message
        : String(err);
    return { status: "failed", errorMessage, durationMs };
  }
}

export class MerchantWebhookService {
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;

  constructor(
    fetchImpl: typeof fetch = fetch,
    options: Omit<MerchantWebhookServiceOptions, "fetchImpl"> = {},
  ) {
    this.fetchImpl = fetchImpl;
    this.maxAttempts = Math.max(
      1,
      options.maxAttempts ??
        Number(process.env.WEBHOOK_RETRY_MAX_ATTEMPTS ?? 3),
    );
    this.baseDelayMs = Math.max(
      0,
      options.baseDelayMs ??
        Number(process.env.WEBHOOK_RETRY_BASE_DELAY_MS ?? 500),
    );
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger ?? console;
  }

  /**
   * Send a test delivery using the canonical sample payload.
   * Records the attempt in webhook_delivery_logs with is_test=true.
   */
  async testWebhook(
    webhookId: string,
    userId: string,
  ): Promise<{ log: WebhookDeliveryLog; webhook: MerchantWebhook }> {
    const webhook = await model.findById(webhookId, userId);
    if (!webhook) throw new Error("Webhook not found");

    const payload = {
      ...SAMPLE_WEBHOOK_PAYLOAD,
      timestamp: new Date().toISOString(),
    };

    const result = await deliver(
      webhook.url,
      webhook.secret,
      payload,
      this.fetchImpl,
    );

    const log = await model.insertDeliveryLog({
      webhookId: webhook.id,
      eventType: "transaction.completed",
      payload,
      status: result.status,
      httpStatus: result.httpStatus,
      responseBody: result.responseBody,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
      isTest: true,
    });

    return { log, webhook };
  }

  /**
   * Deliver a real event to all active webhooks for a user that subscribe to the event.
   * Called by the transaction worker after status changes.
   */
  async dispatchEvent(
    userId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const webhooks = await model.findByUserId(userId);
    const active = webhooks.filter(
      (w) => w.isActive && w.events.includes(eventType),
    );

    await Promise.allSettled(
      active.map(async (webhook) => {
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
          const result = await deliver(
            webhook.url,
            webhook.secret,
            payload,
            this.fetchImpl,
          );

          await model.insertDeliveryLog({
            webhookId: webhook.id,
            eventType,
            payload,
            status: result.status,
            httpStatus: result.httpStatus,
            responseBody: result.responseBody,
            errorMessage: result.errorMessage,
            durationMs: result.durationMs,
            isTest: false,
          });

          if (result.status === "delivered") {
            this.logger.log(
              `[merchant-webhook] delivered webhookId=${webhook.id} event=${eventType} attempt=${attempt}`,
            );
            await WebhookCacheInvalidation.invalidateOnWebhookRecovery(
              userId,
              webhook.id,
            );
            return;
          }

          this.logger.warn(
            `[merchant-webhook] delivery failed webhookId=${webhook.id} event=${eventType} attempt=${attempt}/${this.maxAttempts}: ${result.errorMessage ?? "Unknown webhook error"}`,
          );
          if (!isTransientFailure(result) || attempt === this.maxAttempts) {
            if (attempt === this.maxAttempts) {
              this.logger.error(
                `[merchant-webhook] delivery exhausted webhookId=${webhook.id} event=${eventType}`,
              );
            }
            return;
          }

          await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
        }
      }),
    );
  }
}

export const merchantWebhookService = new MerchantWebhookService();
export { model as merchantWebhookModel };
