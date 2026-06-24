import { MobileMoneyProvider, ProviderTransactionStatus } from "../mobileMoneyService";
import { SmsPortalSimulator, SmsPortalSimulatorConfig, CaptchaSolver } from "./smsPortalSimulator";
import logger from "../../../utils/logger";
import { maskPII } from "../../../utils/masking";

export interface SmsPortalProviderConfig {
  paymentUrl: string;
  payoutUrl: string;
  statusUrl: string;
  balanceUrl: string;
  phoneNumberSelector: string;
  amountSelector: string;
  referenceSelector: string;
  submitSelector: string;
  statusSelector: string;
  balanceSelector: string;
  successIndicatorSelector: string;
  errorIndicatorSelector: string;
  simulatorConfig: Partial<SmsPortalSimulatorConfig>;
  requestTimeoutMs: number;
  maxRetries: number;
}

type ProviderResult = {
  success: boolean;
  data?: unknown;
  error?: unknown;
  providerResponseTimeMs?: number;
};

const DEFAULT_STATUS_MAP: Record<string, ProviderTransactionStatus> = {
  completed: "completed",
  success: "completed",
  successful: "completed",
  confirmed: "completed",
  failed: "failed",
  error: "failed",
  rejected: "failed",
  cancelled: "failed",
  pending: "pending",
  processing: "pending",
  initiated: "pending",
};

export class SmsPortalProvider implements MobileMoneyProvider {
  private readonly config: SmsPortalProviderConfig;
  private readonly simulator: SmsPortalSimulator;
  private readonly clock: () => number;

  constructor(
    config: Partial<SmsPortalProviderConfig> = {},
  ) {
    this.clock = Date.now;
    this.config = this.buildConfig(config);
    this.simulator = new SmsPortalSimulator(this.config.simulatorConfig);
  }

  setCaptchaSolver(solver: CaptchaSolver): void {
    (this.config.simulatorConfig as any).captchaSolver = solver;
  }

  async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<ProviderResult> {
    const log = requestId ? logger.child({ requestId }) : logger;
    const startTime = this.clock();
    const reference = requestId ?? `SMS-PAYMENT-${this.clock()}`;

    log.info(
      maskPII({ phoneNumber, amount }),
      "SmsPortalProvider: Requesting payment",
    );

    try {
      const result = await this.simulator.submitFormAndExtract(
        this.config.paymentUrl,
        {
          [this.config.phoneNumberSelector]: phoneNumber,
          [this.config.amountSelector]: amount,
          [this.config.referenceSelector]: reference,
        },
        this.config.submitSelector,
        async (page) => {
          const success = await page.$(this.config.successIndicatorSelector);
          if (success) {
            const text = await success.textContent();
            return {
              success: true,
              data: { message: text, reference },
            };
          }

          const error = await page.$(this.config.errorIndicatorSelector);
          if (error) {
            const text = await error.textContent();
            return { success: false, error: text };
          }

          return { success: true, data: { reference } };
        },
      );

      const duration = this.clock() - startTime;
      return { ...result, providerResponseTimeMs: duration };
    } catch (error: any) {
      const duration = this.clock() - startTime;
      logger.error(
        { duration, error: error.message, reference },
        "SmsPortalProvider: Payment request failed",
      );
      return { success: false, error, providerResponseTimeMs: duration };
    }
  }

  async sendPayout(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<ProviderResult> {
    const log = requestId ? logger.child({ requestId }) : logger;
    const startTime = this.clock();
    const reference = requestId ?? `SMS-PAYOUT-${this.clock()}`;

    log.info(
      maskPII({ phoneNumber, amount }),
      "SmsPortalProvider: Sending payout",
    );

    try {
      const result = await this.simulator.submitFormAndExtract(
        this.config.payoutUrl,
        {
          [this.config.phoneNumberSelector]: phoneNumber,
          [this.config.amountSelector]: amount,
          [this.config.referenceSelector]: reference,
        },
        this.config.submitSelector,
        async (page) => {
          const success = await page.$(this.config.successIndicatorSelector);
          if (success) {
            const text = await success.textContent();
            return {
              success: true,
              data: { message: text, reference },
            };
          }

          const error = await page.$(this.config.errorIndicatorSelector);
          if (error) {
            const text = await error.textContent();
            return { success: false, error: text };
          }

          return { success: true, data: { reference } };
        },
      );

      const duration = this.clock() - startTime;
      return { ...result, providerResponseTimeMs: duration };
    } catch (error: any) {
      const duration = this.clock() - startTime;
      logger.error(
        { duration, error: error.message, reference },
        "SmsPortalProvider: Payout failed",
      );
      return { success: false, error, providerResponseTimeMs: duration };
    }
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: ProviderTransactionStatus }> {
    try {
      const statusUrl = this.config.statusUrl.replace(":reference", encodeURIComponent(referenceId));

      const result = await this.simulator.navigateAndExtract(
        statusUrl,
        async (page) => {
          const el = await page.$(this.config.statusSelector);
          if (!el) return "unknown";
          const raw = (await el.textContent()) ?? "";
          return this.normalizeStatus(raw.trim().toLowerCase());
        },
      );

      return { status: result };
    } catch (error: any) {
      logger.error(
        { error: error.message, referenceId },
        "SmsPortalProvider: Status check failed",
      );
      return { status: "unknown" };
    }
  }

  private normalizeStatus(raw: string): ProviderTransactionStatus {
    return DEFAULT_STATUS_MAP[raw] ?? "unknown";
  }

  private buildConfig(
    overrides: Partial<SmsPortalProviderConfig>,
  ): SmsPortalProviderConfig {
    return {
      paymentUrl:
        overrides.paymentUrl ??
        process.env.SMS_PORTAL_PAYMENT_URL ??
        `${process.env.SMS_PORTAL_URL ?? ""}/payment`,
      payoutUrl:
        overrides.payoutUrl ??
        process.env.SMS_PORTAL_PAYOUT_URL ??
        `${process.env.SMS_PORTAL_URL ?? ""}/payout`,
      statusUrl:
        overrides.statusUrl ??
        process.env.SMS_PORTAL_STATUS_URL ??
        `${process.env.SMS_PORTAL_URL ?? ""}/status/:reference`,
      balanceUrl:
        overrides.balanceUrl ??
        process.env.SMS_PORTAL_BALANCE_URL ??
        `${process.env.SMS_PORTAL_URL ?? ""}/balance`,
      phoneNumberSelector:
        overrides.phoneNumberSelector ??
        process.env.SMS_PORTAL_PHONE_SELECTOR ??
        '[name="phone"]',
      amountSelector:
        overrides.amountSelector ??
        process.env.SMS_PORTAL_AMOUNT_SELECTOR ??
        '[name="amount"]',
      referenceSelector:
        overrides.referenceSelector ??
        process.env.SMS_PORTAL_REFERENCE_SELECTOR ??
        '[name="reference"]',
      submitSelector:
        overrides.submitSelector ??
        process.env.SMS_PORTAL_SUBMIT_SELECTOR ??
        'button[type="submit"]',
      statusSelector:
        overrides.statusSelector ??
        process.env.SMS_PORTAL_STATUS_SELECTOR ??
        ".transaction-status",
      balanceSelector:
        overrides.balanceSelector ??
        process.env.SMS_PORTAL_BALANCE_SELECTOR ??
        ".balance-amount",
      successIndicatorSelector:
        overrides.successIndicatorSelector ??
        process.env.SMS_PORTAL_SUCCESS_INDICATOR ??
        ".success-message",
      errorIndicatorSelector:
        overrides.errorIndicatorSelector ??
        process.env.SMS_PORTAL_ERROR_INDICATOR ??
        ".error-message",
      simulatorConfig: overrides.simulatorConfig ?? {},
      requestTimeoutMs: Number(
        overrides.requestTimeoutMs ??
          process.env.SMS_PORTAL_REQUEST_TIMEOUT_MS ??
          30_000,
      ),
      maxRetries: Number(
        overrides.maxRetries ??
          process.env.SMS_PORTAL_MAX_RETRIES ??
          3,
      ),
    };
  }
}
