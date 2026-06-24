import subscriptionModel from "../models/subscription";
import { TransactionModel } from "../models/transaction";
import { addTransactionJob } from "../queue/transactionQueue";
import { decrypt } from "../utils/encryption";
import { queryWrite } from "../config/database";
import { notificationRouter } from "../services/notificationRouter";

const transactionModel = new TransactionModel();

function computeNextRun(interval: string): string {
  // Return SQL-compatible timestamp string for next run
  if (interval === "daily") return `NOW() + INTERVAL '1 day'`;
  if (interval === "weekly") return `NOW() + INTERVAL '7 days'`;
  // monthly
  return `NOW() + INTERVAL '1 month'`;
}

export async function runSubscriptionJob(): Promise<void> {
  console.log("[subscriptions] Checking for due subscriptions");
  const subs = await subscriptionModel.getDueSubscriptions(200);
  if (!subs.length) {
    console.log("[subscriptions] No due subscriptions");
    return;
  }

  for (const s of subs) {
    try {
      // Create a transaction record linked to this subscription
      const phoneEncrypted = s.phone_number ? s.phone_number : null;
      const phoneNumber = phoneEncrypted ? decrypt(String(phoneEncrypted)) : null;
      const tx = await transactionModel.create({
        type: "deposit",
        amount: s.amount,
        currency: s.currency,
        phoneNumber: phoneNumber,
        provider: (s.metadata && s.metadata.provider) || "",
        status: "pending",
        userId: s.user_id ?? null,
        metadata: { subscription_id: s.id },
        notes: `Recurring collection for subscription ${s.id}`,
      });

      // Record subscription attempt audit
      await subscriptionModel.recordAttempt(s.id, tx?.id ?? null, 1, "pending");

      // Enqueue job to process the transaction
      await addTransactionJob({
        transactionId: tx.id,
        type: "deposit",
        amount: String(s.amount),
        phoneNumber: tx.phoneNumber || "",
        provider: tx.provider || (s.metadata && s.metadata.provider) || "",
        stellarAddress: tx.stellarAddress || "",
      });

      // Advance next_run_at according to interval
      await queryWrite(`UPDATE subscriptions SET last_run_at = NOW(), next_run_at = ${computeNextRun(s.interval)}, updated_at = NOW() WHERE id = $1`, [s.id]);
      console.log(`[subscriptions] Scheduled transaction ${tx.id} for subscription ${s.id}`);
    } catch (err) {
      console.error(`[subscriptions] Error processing subscription ${s.id}:`, err);
    }
  }
}
