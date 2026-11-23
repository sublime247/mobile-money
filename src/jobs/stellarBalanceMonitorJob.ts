/**
 * Stellar Hot Wallet Balance Monitor (#stellar-balance-monitor)
 *
 * Polls Horizon every 2 minutes for the anchor hot wallet and fee account
 * balances. Dispatches high-severity alerts via PagerDuty and Slack/Discord
 * when:
 *   - Native XLM drops below STELLAR_MIN_XLM_BALANCE (default 100 XLM)
 *   - Any issuer asset trustline drops below STELLAR_MIN_ASSET_BALANCE (default 1000)
 *
 * Registered in the scheduler as "stellar-balance-monitor".
 */

import logger from "../utils/logger";
import { getStellarServer } from "../config/stellar";
import { sendAlert } from "../services/alertService";
import { pagerDutyService } from "../services/pagerDutyService";

// ── Config ────────────────────────────────────────────────────────────────────

function getMinXlmBalance(): number {
  return parseFloat(process.env.STELLAR_MIN_XLM_BALANCE || "100");
}

function getMinAssetBalance(): number {
  return parseFloat(process.env.STELLAR_MIN_ASSET_BALANCE || "1000");
}

interface WalletTarget {
  label: string;
  publicKey: string;
}

function getWalletTargets(): WalletTarget[] {
  const targets: WalletTarget[] = [];

  const hot = process.env.STELLAR_HOT_WALLET_PUBLIC_KEY;
  if (hot) targets.push({ label: "hot_wallet", publicKey: hot });

  const fee =
    process.env.STELLAR_FEE_ACCOUNT_PUBLIC_KEY ||
    process.env.STELLAR_FEE_PAYER_PUBLIC_KEY;
  if (fee) targets.push({ label: "fee_account", publicKey: fee });

  return targets;
}

// ── Core check ────────────────────────────────────────────────────────────────

interface BalanceEntry {
  asset: string;   // "XLM" or asset code
  balance: number;
  isNative: boolean;
}

async function fetchBalances(publicKey: string): Promise<BalanceEntry[]> {
  const server = getStellarServer();
  const account = await server.loadAccount(publicKey);

  return account.balances.map((b: any) => ({
    asset: b.asset_type === "native" ? "XLM" : b.asset_code,
    balance: parseFloat(b.balance),
    isNative: b.asset_type === "native",
  }));
}

async function checkWallet(target: WalletTarget): Promise<void> {
  const minXlm = getMinXlmBalance();
  const minAsset = getMinAssetBalance();

  let balances: BalanceEntry[];
  try {
    balances = await fetchBalances(target.publicKey);
  } catch (err) {
    logger.error(
      { wallet: target.label, publicKey: target.publicKey, err },
      "[stellar-balance-monitor] Failed to load account",
    );
    await sendAlert({
      provider: `stellar:${target.label}`,
      error: `Failed to load Horizon account ${target.publicKey}: ${err instanceof Error ? err.message : String(err)}`,
      severity: "error",
      meta: { wallet: target.label },
    });
    return;
  }

  for (const entry of balances) {
    const threshold = entry.isNative ? minXlm : minAsset;

    if (entry.balance >= threshold) {
      logger.debug(
        { wallet: target.label, asset: entry.asset, balance: entry.balance, threshold },
        "[stellar-balance-monitor] Balance OK",
      );
      // Resolve any open PagerDuty incident for this asset
      await pagerDutyService.resolveBalanceShortfallIncident(
        `stellar:${target.label}`,
        entry.asset,
      );
      continue;
    }

    const shortfallPct = Math.round(
      ((threshold - entry.balance) / threshold) * 100,
    );
    const severity =
      shortfallPct >= 50 ? "critical" : shortfallPct >= 25 ? "error" : "warning";

    logger.warn(
      { wallet: target.label, asset: entry.asset, balance: entry.balance, threshold, shortfallPct },
      "[stellar-balance-monitor] Balance below threshold",
    );

    // PagerDuty
    await pagerDutyService.handleBalanceShortfall(
      `stellar:${target.label}`,
      entry.asset,
      threshold,
      entry.balance,
    );

    // Slack / Discord
    await sendAlert(
      {
        provider: `stellar:${target.label}`,
        error: `Stellar ${target.label} ${entry.asset} balance is ${entry.balance} — below threshold of ${threshold}`,
        severity,
        meta: {
          wallet: target.label,
          publicKey: target.publicKey,
          asset: entry.asset,
          balance: entry.balance,
          threshold,
          shortfallPct,
        },
      },
      { cooldownMs: 2 * 60 * 1000 }, // 2-min cooldown matches poll interval
    );
  }
}

// ── Job entry point ───────────────────────────────────────────────────────────

export async function runStellarBalanceMonitorJob(): Promise<void> {
  const targets = getWalletTargets();

  if (targets.length === 0) {
    logger.warn(
      "[stellar-balance-monitor] No wallet public keys configured " +
        "(STELLAR_HOT_WALLET_PUBLIC_KEY / STELLAR_FEE_ACCOUNT_PUBLIC_KEY)",
    );
    return;
  }

  await Promise.all(targets.map(checkWallet));
}
