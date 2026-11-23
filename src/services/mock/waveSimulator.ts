import axios from "axios";
import { createHmac } from "crypto";

export class WaveSimulator {
  private readonly webhookSecret: string;
  private readonly webhookUrl: string;

  constructor() {
    this.webhookSecret = process.env.WAVE_WEBHOOK_SECRET || "test_secret";
    this.webhookUrl =
      process.env.WAVE_WEBHOOK_URL || "http://localhost:3000/api/webhooks/wave"; // Default, to be overridden in tests
  }

  /**
   * Generates a signature for the webhook payload.
   */
  private generateSignature(payload: string): string {
    return (
      "sha256=" +
      createHmac("sha256", this.webhookSecret).update(payload).digest("hex")
    );
  }

  /**
   * Dispatches a simulated webhook event after a delay.
   *
   * `checkoutSessionId` is reused as the webhook's `data.id` so retries of the
   * same checkout resolve to the same idempotency key.
   */
  public async dispatchWebhook(
    checkoutSessionId: string,
    clientReference: string,
    status: "succeeded" | "cancelled" | "processing",
    amount: string,
    currency: string = "XOF",
    delayMs: number = 0,
  ): Promise<void> {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const payload = {
      id: `evt_${checkoutSessionId}`,
      type: "checkout.session.completed",
      data: {
        id: checkoutSessionId,
        client_reference: clientReference,
        payment_status: status,
        amount,
        currency,
        transaction_id: `txn_${Date.now()}`,
      },
    };

    const rawPayload = JSON.stringify(payload);
    const signature = this.generateSignature(rawPayload);

    try {
      await axios.post(this.webhookUrl, rawPayload, {
        headers: {
          "Content-Type": "application/json",
          "wave-signature": signature,
        },
      });
    } catch (error) {
      console.error("[WaveSimulator] Failed to dispatch webhook:", error);
    }
  }

  /**
   * Generates a mock checkout session response.
   */
  public createCheckoutSession(
    amount: string,
    currency: string,
    clientReference: string,
  ) {
    return {
      id: `cs_${Date.now()}`,
      amount,
      currency,
      client_reference: clientReference,
      wave_launch_url: `https://mock.wave.com/checkout?c=${clientReference}`,
      payment_status: "processing",
    };
  }
}
