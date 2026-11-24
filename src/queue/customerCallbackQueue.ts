import logger from "../utils/logger";
import { Queue, Worker, Job, UnrecoverableError } from "bullmq";
import { queueOptions } from "./config";
import { validateWebhookUrl } from "../security/ssrf";
import { createWebhookSignature, computeWebhookSignature } from "../utils/webhookSigner";

export const CUSTOMER_CALLBACK_QUEUE_NAME = "customer-status-callbacks";

export interface CustomerCallbackJobData {
  jobId?: string;
  customerId: string;
  account?: string;
  status: string;
  previousStatus: string;
  callbackUrl: string;
  secret: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export const customerCallbackQueue = new Queue<CustomerCallbackJobData>(
  CUSTOMER_CALLBACK_QUEUE_NAME,
  queueOptions,
);

export async function enqueueCustomerCallback(
  data: CustomerCallbackJobData,
): Promise<void> {
  const jobId =
    data.jobId ||
    `customer-cb-${data.customerId}-${data.status}-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  await customerCallbackQueue.add("deliver-customer-callback", { ...data, jobId }, {
    jobId,
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: { count: 500, age: 7 * 24 * 3600 },
    removeOnFail: { count: 1000, age: 30 * 24 * 3600 },
  });
}

/** HTTP statuses treated as transient partner failures worth retrying. */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 425, 429]);

/**
 * Whether a failed delivery should be retried: 5xx, timeouts and rate limits
 * are transient; any other 4xx means the partner rejected the request and
 * retrying would not help.
 */
export function isRetryableCallbackStatus(statusCode: number): boolean {
  return statusCode >= 500 || RETRYABLE_CLIENT_STATUSES.has(statusCode);
}

export interface CustomerCallbackDeliveryResult {
  status: "delivered" | "failed" | "blocked";
  statusCode?: number;
  error?: string;
  /** For failed deliveries: whether the failure is transient. */
  retryable?: boolean;
}

/**
 * Deliver a customer status callback to the target URL with HMAC signature.
 */
export async function deliverCustomerCallback(
  jobData: CustomerCallbackJobData,
  fetchImpl: typeof fetch = fetch,
): Promise<CustomerCallbackDeliveryResult> {
  const { customerId, callbackUrl, secret, payload, timestamp } = jobData;

  try {
    await validateWebhookUrl(callbackUrl);
  } catch (error: any) {
    logger.error(
      { customerId, callbackUrl, error: error.message },
      "[customer-callback] Delivery blocked by SSRF policy",
    );
    return { status: "blocked", error: error.message };
  }

  const payloadString = JSON.stringify(payload);
  const sigHeaders = createWebhookSignature(payloadString, secret, timestamp);
  const hmacHex = computeWebhookSignature(payloadString, secret, timestamp);

  let response: Response;
  try {
    response = await fetchImpl(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Momo-Signature": sigHeaders["X-Momo-Signature"],
        "X-Momo-Timestamp": sigHeaders["X-Momo-Timestamp"],
        "X-Webhook-Signature": `sha256=${hmacHex}`,
      },
      body: payloadString,
    });
  } catch (error: any) {
    // Network errors / timeouts are transient.
    logger.error(
      { customerId, callbackUrl, error: error.message },
      "[customer-callback] Error delivering customer webhook callback",
    );
    return { status: "failed", error: error.message, retryable: true };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    const errMsg = `HTTP error ${response.status}: ${errText}`;
    const retryable = isRetryableCallbackStatus(response.status);
    logger.warn(
      { customerId, callbackUrl, status: response.status, retryable },
      `[customer-callback] Failed callback response: ${errMsg}`,
    );
    return {
      status: "failed",
      statusCode: response.status,
      error: errMsg,
      retryable,
    };
  }

  logger.info(
    { customerId, callbackUrl, status: response.status },
    "[customer-callback] Webhook callback delivered successfully",
  );
  return { status: "delivered", statusCode: response.status };
}

/**
 * BullMQ processor: throws a retryable error for transient partner failures
 * (so the job is retried with backoff) and an `UnrecoverableError` for
 * permanent ones (so it fails immediately without burning retries).
 */
export async function processCustomerCallbackJob(
  job: Pick<Job<CustomerCallbackJobData>, "data">,
  fetchImpl: typeof fetch = fetch,
): Promise<CustomerCallbackDeliveryResult> {
  const result = await deliverCustomerCallback(job.data, fetchImpl);
  if (result.status === "failed") {
    const message = result.error || "Delivery failed";
    if (result.retryable === false) {
      throw new UnrecoverableError(message);
    }
    throw new Error(message);
  }
  return result;
}

export let customerCallbackWorker: Worker<CustomerCallbackJobData> | null = null;

export function startCustomerCallbackWorker(fetchImpl: typeof fetch = fetch): Worker<CustomerCallbackJobData> {
  if (customerCallbackWorker) {
    return customerCallbackWorker;
  }

  customerCallbackWorker = new Worker<CustomerCallbackJobData>(
    CUSTOMER_CALLBACK_QUEUE_NAME,
    async (job: Job<CustomerCallbackJobData>) => {
      await processCustomerCallbackJob(job, fetchImpl);
    },
    queueOptions,
  );

  return customerCallbackWorker;
}

export async function closeCustomerCallbackWorker(): Promise<void> {
  if (customerCallbackWorker) {
    await customerCallbackWorker.close();
    customerCallbackWorker = null;
  }
}

export async function closeCustomerCallbackQueue(): Promise<void> {
  await customerCallbackQueue.close();
}
