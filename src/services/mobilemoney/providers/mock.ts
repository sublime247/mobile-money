import {
  MobileMoneyProvider,
  ProviderTransactionStatus,
} from "../mobileMoneyService";
import logger from "../../../utils/logger";
import { maskPII } from "../../../utils/masking";

/**
 * Mock webhook callback payload delivered after a simulated deposit/payout,
 * mirroring the shape a real provider webhook would carry (transaction
 * reference, final status, operation). See `MockProvider`'s class doc for
 * why this is a lightweight injectable callback rather than a call into the
 * production webhook outbox (src/services/webhook.ts).
 */
export interface MockWebhookCallbackPayload {
  transactionId: string;
  operation: "requestPayment" | "sendPayout";
  status: "SUCCESSFUL" | "FAILED";
  phoneNumber: string;
  amount: string;
}

export type MockWebhookCallback = (
  payload: MockWebhookCallbackPayload,
) => void | Promise<void>;

export interface MockProviderOptions {
  /**
   * Simulated provider latency in milliseconds before a result resolves.
   * Defaults to 0 (synchronous) so existing callers/tests are unaffected
   * unless they opt in. Can be a fixed number or a `[min, max]` range for a
   * randomized delay within that window.
   */
  simulatedDelayMs?: number | [number, number];
  /**
   * Probability (0-1) that a call succeeds. Defaults to 1 (always succeeds),
   * matching the provider's pre-#2274 behavior. Values are clamped to
   * [0, 1].
   */
  successRate?: number;
  /**
   * Called after a simulated delay once an operation settles, carrying the
   * same success/failure outcome - a lightweight stand-in for a provider's
   * asynchronous payment-status webhook so staging integration tests can
   * exercise a full "initiate -> webhook callback" cycle without needing a
   * real inbound HTTP callback or the production webhook outbox
   * (src/services/webhook.ts), which expects a persisted transaction row
   * this provider has no access to.
   */
  onWebhookCallback?: MockWebhookCallback;
  /** Deterministic RNG seam for tests; defaults to Math.random. */
  random?: () => number;
  /** Clock seam for tests; defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_SUCCESS_RATE = 1;

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return DEFAULT_SUCCESS_RATE;
  return Math.max(0, Math.min(1, rate));
}

/**
 * Env-var defaults so the provider factory (loadProvider("mock") in
 * mobileMoneyService_impl.js) - which always calls `new MockProvider()`
 * with no arguments - can still be configured without code changes, e.g. in
 * a staging deployment. Explicit constructor options always win over these.
 *
 * `MOCK_PROVIDER_DELAY_MS` accepts either a single number ("250") or a
 * "min-max" range ("100-400"). Distinct from `PROVIDER_MOCK_DELAY_MS`, which
 * configures the separate standalone offline mock HTTP server
 * (PROVIDER_MOCK_PORT), not this in-process provider class.
 */
function envDelayMs(): number | [number, number] | undefined {
  const raw = process.env.MOCK_PROVIDER_DELAY_MS?.trim();
  if (!raw) return undefined;

  if (raw.includes("-")) {
    const [minRaw, maxRaw] = raw.split("-", 2);
    const min = Number(minRaw);
    const max = Number(maxRaw);
    if (Number.isFinite(min) && Number.isFinite(max)) return [min, max];
    return undefined;
  }

  const fixed = Number(raw);
  return Number.isFinite(fixed) ? fixed : undefined;
}

function envSuccessRate(): number | undefined {
  const raw = process.env.MOCK_PROVIDER_SUCCESS_RATE?.trim();
  if (!raw) return undefined;
  const rate = Number(raw);
  return Number.isFinite(rate) ? rate : undefined;
}

export class MockProvider implements MobileMoneyProvider {
  private readonly simulatedDelayMs: number | [number, number];
  private readonly successRate: number;
  private readonly onWebhookCallback?: MockWebhookCallback;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: MockProviderOptions = {}) {
    this.simulatedDelayMs = options.simulatedDelayMs ?? envDelayMs() ?? 0;
    this.successRate = clampRate(
      options.successRate ?? envSuccessRate() ?? DEFAULT_SUCCESS_RATE,
    );
    this.onWebhookCallback = options.onWebhookCallback;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  private resolveDelayMs(): number {
    if (Array.isArray(this.simulatedDelayMs)) {
      const [min, max] = this.simulatedDelayMs;
      if (max <= min) return Math.max(0, min);
      return min + this.random() * (max - min);
    }
    return Math.max(0, this.simulatedDelayMs);
  }

  private async simulateLatency(): Promise<void> {
    const delay = this.resolveDelayMs();
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private rollSuccess(): boolean {
    return this.random() < this.successRate;
  }

  private fireWebhookCallback(payload: MockWebhookCallbackPayload): void {
    if (!this.onWebhookCallback) return;
    // Fire-and-forget: a webhook callback is asynchronous by nature and must
    // never block or fail the initiating request/payout call.
    Promise.resolve()
      .then(() => this.onWebhookCallback!(payload))
      .catch((error) =>
        logger.warn(
          { err: error instanceof Error ? error.message : error },
          "MockProvider: webhook callback simulation failed",
        ),
      );
  }

  async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info(
      maskPII({ phoneNumber, amount }),
      "MockProvider: Requesting payment",
    );

    await this.simulateLatency();

    const transactionId = `mock-pay-${this.now()}`;
    const succeeded = this.rollSuccess();

    this.fireWebhookCallback({
      transactionId,
      operation: "requestPayment",
      status: succeeded ? "SUCCESSFUL" : "FAILED",
      phoneNumber,
      amount,
    });

    if (!succeeded) {
      return {
        success: false,
        error: {
          code: "MOCK_PAYMENT_FAILED",
          message: "Simulated payment failure (MockProvider successRate)",
        },
        providerResponseTimeMs: 0,
      };
    }

    return {
      success: true,
      data: {
        transactionId,
        status: "PENDING",
      },
      providerResponseTimeMs: 0,
    };
  }

  async sendPayout(phoneNumber: string, amount: string, requestId?: string) {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.info(maskPII({ phoneNumber, amount }), "MockProvider: Sending payout");

    await this.simulateLatency();

    const transactionId = `mock-payout-${this.now()}`;
    const succeeded = this.rollSuccess();

    this.fireWebhookCallback({
      transactionId,
      operation: "sendPayout",
      status: succeeded ? "SUCCESSFUL" : "FAILED",
      phoneNumber,
      amount,
    });

    if (!succeeded) {
      return {
        success: false,
        error: {
          code: "MOCK_PAYOUT_FAILED",
          message: "Simulated payout failure (MockProvider successRate)",
        },
        providerResponseTimeMs: 0,
      };
    }

    return {
      success: true,
      data: {
        transactionId,
        status: "SUCCESSFUL",
      },
      providerResponseTimeMs: 0,
    };
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: ProviderTransactionStatus }> {
    logger.info(maskPII({ referenceId }), "MockProvider: Checking status");
    return { status: "completed" };
  }
}
