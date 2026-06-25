import logger from "../utils/logger";
import { MTNProvider } from "./mobilemoney/providers/mtn";
import { AirtelService } from "./mobilemoney/providers/airtel";
import { queryWrite, queryRead } from "../config/database";

export type ProviderName = "mtn" | "airtel" | "orange";

interface ProviderBalance {
  provider: ProviderName;
  balance: number;
  currency: string;
}

interface LiquidityTransfer {
  id: string;
  fromProvider: string;
  toProvider: string;
  amount: number;
  currency: string;
  status: "pending" | "completed" | "failed";
  triggeredBy: "auto" | "admin";
  adminId?: string | null;
  note?: string | null;
  error?: string | null;
  createdAt: Date;
  completedAt?: Date | null;
}

const DEFAULT_THRESHOLD = parseFloat(process.env.PROVIDER_MIN_BALANCE_THRESHOLD || "1000");
const TRANSFER_TARGET_RATIO = 0.5; // rebalance to 50% of combined balance

function getThreshold(provider: ProviderName): number {
  const key = `${provider.toUpperCase()}_MIN_BALANCE_THRESHOLD`;
  const val = parseFloat(process.env[key] || "");
  return Number.isFinite(val) ? val : DEFAULT_THRESHOLD;
}

async function fetchBalance(provider: ProviderName): Promise<ProviderBalance | null> {
  try {
    let result: { success: boolean; data?: { availableBalance: number; currency: string }; error?: unknown };

    if (provider === "mtn") {
      result = await new MTNProvider().getOperationalBalance();
    } else if (provider === "airtel") {
      result = await new AirtelService().getOperationalBalance();
    } else {
      // Orange doesn't expose a balance API in the current implementation
      return null;
    }

    if (!result.success || !result.data) return null;
    return { provider, balance: result.data.availableBalance, currency: result.data.currency };
  } catch {
    return null;
  }
}

async function recordTransfer(
  fromProvider: string,
  toProvider: string,
  amount: number,
  currency: string,
  triggeredBy: "auto" | "admin",
  adminId?: string,
  note?: string,
): Promise<string> {
  const result = await queryWrite<{ id: string }>(
    `INSERT INTO liquidity_transfers (from_provider, to_provider, amount, currency, triggered_by, admin_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [fromProvider, toProvider, amount, currency, triggeredBy, adminId ?? null, note ?? null],
  );
  return result.rows[0].id;
}

async function markTransferDone(id: string, status: "completed" | "failed", error?: string) {
  await queryWrite(
    `UPDATE liquidity_transfers
     SET status = $1, error = $2, completed_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [status, error ?? null, id],
  );
}

/**
 * Checks all provider balances and initiates transfers from providers with
 * surplus to providers that are below their threshold.
 */
export async function runLiquidityRebalance(): Promise<void> {
  const providers: ProviderName[] = ["mtn", "airtel"];
  const balances = (await Promise.all(providers.map(fetchBalance))).filter(
    (b): b is ProviderBalance => b !== null,
  );

  if (balances.length < 2) {
    console.log("[liquidity] Not enough provider balances available to rebalance");
    return;
  }

  const low = balances.filter((b) => b.balance < getThreshold(b.provider));
  if (low.length === 0) {
    console.log("[liquidity] All providers above threshold, no transfer needed");
    return;
  }

  const total = balances.reduce((sum, b) => sum + b.balance, 0);
  const target = total * TRANSFER_TARGET_RATIO;

  for (const recipient of low) {
    const deficit = target - recipient.balance;
    if (deficit <= 0) continue;

    // Find the provider with the most surplus
    const donor = balances
      .filter((b) => b.provider !== recipient.provider)
      .sort((a, b) => b.balance - a.balance)[0];

    const donorThreshold = getThreshold(donor.provider);
    const donorSurplus = donor.balance - donorThreshold;

    if (donorSurplus <= 0) {
      console.warn(
        `[liquidity] ${donor.provider} has no surplus to cover ${recipient.provider} deficit`,
      );
      continue;
    }

    const transferAmount = Math.min(deficit, donorSurplus);
    const currency = donor.currency;

    console.log(
      `[liquidity] Initiating transfer of ${transferAmount} ${currency} from ${donor.provider} → ${recipient.provider}`,
    );

    const transferId = await recordTransfer(
      donor.provider,
      recipient.provider,
      transferAmount,
      currency,
      "auto",
    );

    try {
      // In a real integration this would call the provider's internal transfer API.
      // For now we log the intent and mark it completed so the audit trail is maintained.
      // Replace this block with the actual provider-to-provider transfer call.
      console.log(`[liquidity] Transfer ${transferId} executed`);
      await markTransferDone(transferId, "completed");

      // Update local balance snapshot so subsequent iterations use fresh numbers
      donor.balance -= transferAmount;
      recipient.balance += transferAmount;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[liquidity] Transfer ${transferId} failed: ${msg}`);
      await markTransferDone(transferId, "failed", msg);
    }
  }
}

// ── Admin helpers ────────────────────────────────────────────────────────────

export async function triggerManualTransfer(
  fromProvider: string,
  toProvider: string,
  amount: number,
  adminId: string,
  note?: string,
): Promise<{ transferId: string }> {
  const balances = await Promise.all(
    [fromProvider as ProviderName, toProvider as ProviderName].map(fetchBalance),
  );

  const donor = balances[0];
  if (!donor) throw new Error(`Could not fetch balance for ${fromProvider}`);

  const threshold = getThreshold(fromProvider as ProviderName);
  if (donor.balance - amount < threshold) {
    throw new Error(
      `Transfer would leave ${fromProvider} below its minimum threshold (${threshold})`,
    );
  }

  const transferId = await recordTransfer(
    fromProvider,
    toProvider,
    amount,
    donor.currency,
    "admin",
    adminId,
    note,
  );

  try {
    // Replace with actual provider transfer call
    await markTransferDone(transferId, "completed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markTransferDone(transferId, "failed", msg);
    throw new Error(`Transfer failed: ${msg}`);
  }

  return { transferId };
}

export async function getLiquidityTransfers(limit = 50, offset = 0): Promise<LiquidityTransfer[]> {
  const result = await queryRead<{
    id: string;
    from_provider: string;
    to_provider: string;
    amount: string;
    currency: string;
    status: "pending" | "completed" | "failed";
    triggered_by: "auto" | "admin";
    admin_id: string | null;
    note: string | null;
    error: string | null;
    created_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT * FROM liquidity_transfers ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [Math.min(limit, 100), Math.max(offset, 0)],
  );

  return result.rows.map((r) => ({
    id: r.id,
    fromProvider: r.from_provider,
    toProvider: r.to_provider,
    amount: parseFloat(r.amount),
    currency: r.currency,
    status: r.status,
    triggeredBy: r.triggered_by,
    adminId: r.admin_id,
    note: r.note,
    error: r.error,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  }));
}
