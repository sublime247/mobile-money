import logger from "../../utils/logger";
import * as StellarSdk from "@stellar/stellar-sdk";
import { getStellarServer } from "../../config/stellar";
import { notifySlackAlert } from "../loggers";
import { emailService } from "../email";

export interface SponsorBalanceCheckResult {
  publicKey: string;
  balance: number;
  threshold: number;
  lowBalance: boolean;
  alerted: boolean;
  error?: string;
}

export interface SponsorAlertNotificationPayload {
  publicKey: string;
  currentBalance: number;
  threshold: number;
  currency: string;
  timestamp: string;
}

/**
 * Resolves the fee-bump sponsor wallet public key from environment variables.
 */
export function getSponsorWalletPublicKey(): string | null {
  const account =
    process.env.STELLAR_FEE_BUMP_SPONSOR_ACCOUNT ||
    process.env.STELLAR_SPONSOR_PUBLIC_KEY ||
    process.env.STELLAR_SPONSOR_ACCOUNT ||
    process.env.STELLAR_ISSUER_ACCOUNT;

  if (account && account.trim().length > 0) {
    return account.trim();
  }

  // If secret is supplied, derive public key
  const secret =
    process.env.STELLAR_FEE_BUMP_SPONSOR_SECRET ||
    process.env.STELLAR_SPONSOR_SECRET ||
    process.env.STELLAR_ISSUER_SECRET;

  if (secret && secret.trim().length > 0) {
    try {
      return StellarSdk.Keypair.fromSecret(secret.trim()).publicKey();
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Returns the configured XLM threshold for the fee-bump sponsor wallet (default: 50 XLM).
 */
export function getSponsorWalletThreshold(): number {
  const envVal =
    process.env.FEE_BUMP_SPONSOR_BALANCE_THRESHOLD_XLM ||
    process.env.SPONSOR_WALLET_MIN_BALANCE_XLM ||
    process.env.STELLAR_SPONSOR_MIN_BALANCE_XLM;

  if (!envVal) return 50;
  const parsed = parseFloat(envVal);
  return isNaN(parsed) || parsed < 0 ? 50 : parsed;
}

/**
 * Queries the Horizon API for the sponsor account native XLM balance.
 */
export async function getSponsorWalletBalance(
  publicKey: string,
  serverInstance?: StellarSdk.Horizon.Server,
): Promise<number> {
  const server = serverInstance || getStellarServer();
  const account = await server.loadAccount(publicKey);

  const nativeBalanceObj = account.balances.find(
    (b) => b.asset_type === "native",
  );

  if (!nativeBalanceObj) {
    return 0;
  }

  return parseFloat(nativeBalanceObj.balance) || 0;
}

/**
 * Dispatches alert notifications (Slack and Email) when sponsor balance drops below threshold.
 */
export async function sendSponsorLowBalanceAlert(
  payload: SponsorAlertNotificationPayload,
): Promise<void> {
  const message = `[ALERT] Stellar Fee-Bump Sponsor Wallet (${payload.publicKey}) is LOW on funds! Current balance: ${payload.currentBalance.toFixed(2)} ${payload.currency} (configured threshold: ${payload.threshold.toFixed(2)} ${payload.currency}). Please fund immediately to prevent fee-bump transaction failures.`;

  logger.warn({ payload }, message);

  // 1. Send Slack Alert
  try {
    await notifySlackAlert({
      statusCode: 500,
      method: "CRON",
      path: "/jobs/sponsor-wallet-monitor",
      error: new Error(message),
      timestamp: payload.timestamp,
    });
  } catch (slackErr) {
    logger.error(
      { error: slackErr },
      "[fee-bump-monitor] Failed to send Slack alert for sponsor low balance",
    );
  }

  // 2. Send Admin Email Alert
  const alertEmails = (process.env.ADMIN_ALERT_EMAILS || "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  if (alertEmails.length > 0) {
    await Promise.all(
      alertEmails.map((email) =>
        emailService
          .sendAdminBalanceAlert(email, [
            {
              provider: "stellar_sponsor_fee_bump",
              availableBalance: payload.currentBalance,
              threshold: payload.threshold,
              currency: payload.currency,
              timestamp: payload.timestamp,
            },
          ])
          .catch((emailErr) => {
            logger.error(
              { email, error: emailErr },
              "[fee-bump-monitor] Failed to send Email alert for sponsor low balance",
            );
          }),
      ),
    );
  }
}

/**
 * Checks the fee-bump sponsor wallet balance and triggers alerts if below threshold.
 */
export async function checkFeeBumpSponsorBalance(options?: {
  publicKey?: string;
  threshold?: number;
  server?: StellarSdk.Horizon.Server;
}): Promise<SponsorBalanceCheckResult> {
  const publicKey = options?.publicKey || getSponsorWalletPublicKey();
  const threshold = options?.threshold ?? getSponsorWalletThreshold();

  if (!publicKey) {
    logger.warn(
      "[fee-bump-monitor] No sponsor wallet public key or secret configured. Skipping balance check.",
    );
    return {
      publicKey: "",
      balance: 0,
      threshold,
      lowBalance: false,
      alerted: false,
      error: "No sponsor wallet configured",
    };
  }

  try {
    const balance = await getSponsorWalletBalance(publicKey, options?.server);
    const lowBalance = balance < threshold;
    let alerted = false;

    if (lowBalance) {
      alerted = true;
      await sendSponsorLowBalanceAlert({
        publicKey,
        currentBalance: balance,
        threshold,
        currency: "XLM",
        timestamp: new Date().toISOString(),
      });
    }

    return {
      publicKey,
      balance,
      threshold,
      lowBalance,
      alerted,
    };
  } catch (error: any) {
    logger.error(
      { publicKey, error },
      "[fee-bump-monitor] Failed to query sponsor wallet balance from Horizon API",
    );
    return {
      publicKey,
      balance: 0,
      threshold,
      lowBalance: false,
      alerted: false,
      error: error?.message || String(error),
    };
  }
}

/**
 * Hourly cron job runner for automated sponsor wallet monitoring.
 */
export async function runSponsorWalletMonitorJob(): Promise<void> {
  logger.info("[fee-bump-monitor] Running sponsor wallet balance check job...");
  const result = await checkFeeBumpSponsorBalance();
  if (result.lowBalance) {
    logger.warn(
      `[fee-bump-monitor] Sponsor wallet balance is ${result.balance} XLM (below threshold ${result.threshold} XLM). Alert sent.`,
    );
  } else if (!result.error) {
    logger.info(
      `[fee-bump-monitor] Sponsor wallet balance healthy: ${result.balance} XLM (threshold: ${result.threshold} XLM).`,
    );
  }
}
