import logger from "../utils/logger";
import { Queue, Worker, Job } from "bullmq";
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

/**
 * Deliver a customer status callback to the target URL with HMAC signature.
 */
export async function deliverCustomerCallback(
  jobData: CustomerCallbackJobData,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "delivered" | "failed" | "blocked"; statusCode?: number; error?: string }> {
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

  try {
    const response = await fetchImpl(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Momo-Signature": sigHeaders["X-Momo-Signature"],
        "X-Momo-Timestamp": sigHeaders["X-Momo-Timestamp"],
        "X-Webhook-Signature": `sha256=${hmacHex}`,
      },
      body: payloadString,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      const errMsg = `HTTP error ${response.status}: ${errText}`;
      logger.warn(
        { customerId, callbackUrl, status: response.status },
        `[customer-callback] Failed callback response: ${errMsg}`,
      );
      throw new Error(errMsg);
    }

    logger.info(
      { customerId, callbackUrl, status: response.status },
      "[customer-callback] Webhook callback delivered successfully",
    );
    return { status: "delivered", statusCode: response.status };
  } catch (error: any) {
    logger.error(
      { customerId, callbackUrl, error: error.message },
      "[customer-callback] Error delivering customer webhook callback",
    );
    return { status: "failed", error: error.message };
  }
}

export let customerCallbackWorker: Worker<CustomerCallbackJobData> | null = null;

export function startCustomerCallbackWorker(fetchImpl: typeof fetch = fetch): Worker<CustomerCallbackJobData> {
  if (customerCallbackWorker) {
    return customerCallbackWorker;
  }

  customerCallbackWorker = new Worker<CustomerCallbackJobData>(
    CUSTOMER_CALLBACK_QUEUE_NAME,
    async (job: Job<CustomerCallbackJobData>) => {
      const result = await deliverCustomerCallback(job.data, fetchImpl);
      if (result.status === "failed") {
        throw new Error(result.error || "Delivery failed");
      }
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
