import axios, { AxiosInstance } from "axios";
import { createHmac } from "crypto";

interface WavePaymentResponse {
  id?: string;
  status?: string;
  wave_launch_url?: string;
  client_reference?: string;
}

interface WaveTransactionResponse {
  id?: string;
  status?: string;
  amount?: string | number;
  currency?: string;
  client_reference?: string;
}

interface WavePayoutResponse {
  id?: string;
  status?: string;
  error?: string;
}

export class WaveSenegalProvider {
  private readonly client: AxiosInstance;
  private readonly apiKey: string;
  private readonly webhookSecret: string;
  private readonly currency: string;

  constructor() {
    this.apiKey = process.env.WAVE_API_KEY || "";
    this.webhookSecret = process.env.WAVE_WEBHOOK_SECRET || "";
    this.currency = process.env.WAVE_CURRENCY || "XOF";

    this.client = axios.create({
      baseURL: process.env.WAVE_BASE_URL || "https://api.wave.com/v1",
      timeout: Number(process.env.WAVE_TIMEOUT_MS || 30000),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Request a payment (collection) from a customer phone number.
   * Returns a Wave checkout session with a launch URL.
   */
  async requestPayment(
    phoneNumber: string,
    amount: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    try {
      const clientReference = `WAVE-PAY-${Date.now()}`;
      const response = await this.client.post<WavePaymentResponse>(
        "/checkout/sessions",
        {
          amount: String(amount),
          currency: this.currency,
          client_reference: clientReference,
          success_url: process.env.WAVE_SUCCESS_URL || "",
          error_url: process.env.WAVE_ERROR_URL || "",
          // Pre-fill recipient phone to reduce friction
          recipient_mobile_number: this.normalizePhone(phoneNumber),
        },
      );

      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error };
    }
  }

  /**
   * Send a payout (disbursement) to a mobile number.
   * Uses Wave's B2C transfer endpoint.
   */
  async sendPayout(
    phoneNumber: string,
    amount: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }> {
    try {
      const clientReference = `WAVE-OUT-${Date.now()}`;
      const response = await this.client.post<WavePayoutResponse>(
        "/b2c/transfers",
        {
          receive_amount: String(amount),
          currency: this.currency,
          mobile: this.normalizePhone(phoneNumber),
          client_reference: clientReference,
          name: process.env.WAVE_BUSINESS_NAME || "Mobile Money Bridge",
        },
      );

      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error };
    }
  }

  /**
   * Retrieve the canonical status of a transaction by Wave transaction ID.
   */
  async getTransactionStatus(
    transactionId: string,
  ): Promise<{ status: "completed" | "failed" | "pending" | "unknown" }> {
    try {
      const response = await this.client.get<WaveTransactionResponse>(
        `/transactions/${encodeURIComponent(transactionId)}`,
      );

      return { status: this.mapStatus(response.data?.status) };
    } catch {
      return { status: "unknown" };
    }
  }

  /**
   * Verify a Wave webhook signature.
   * Wave signs payloads with HMAC-SHA256 using the webhook secret.
   * The signature is sent in the `X-Wave-Signature` header as `sha256=<hex>`.
   */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
    if (!this.webhookSecret) return false;

    const expected =
      "sha256=" +
      createHmac("sha256", this.webhookSecret)
        .update(rawBody)
        .digest("hex");

    // Constant-time comparison to prevent timing attacks
    if (expected.length !== signature.length) return false;

    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  }

  /** Map Wave API status strings to our canonical status. */
  private mapStatus(
    waveStatus?: string,
  ): "completed" | "failed" | "pending" | "unknown" {
    switch ((waveStatus ?? "").toLowerCase()) {
      case "succeeded":
      case "complete":
        return "completed";
      case "failed":
      case "error":
        return "failed";
      case "pending":
      case "processing":
        return "pending";
      default:
        return "unknown";
    }
  }

  /**
   * Normalize a phone number to the E.164-ish format Wave expects (no leading +).
   * Senegal country code: 221
   */
  private normalizePhone(phoneNumber: string): string {
    const digits = phoneNumber.replace(/\D/g, "");
    if (digits.startsWith("221")) return digits;
    if (digits.startsWith("0")) return `221${digits.slice(1)}`;
    return `221${digits}`;
  }
}
