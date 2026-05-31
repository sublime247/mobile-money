import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../../config/stellar";

export interface ReserveConfig {
  assetCode: string;
  assetIssuer: string; // empty string = native XLM
  minReserve: number; // trigger rebalance below this
  targetReserve: number;
}

export interface RebalanceResult {
  assetCode: string;
  currentBalance: number;
  targetReserve: number;
  amountSwapped: number;
  txHash: string | null;
  skipped: boolean;
  reason?: string;
}

function getDistributionKeypair(): StellarSdk.Keypair | null {
  const secret = process.env.STELLAR_DISTRIBUTION_SECRET?.trim();
  if (!secret) return null;
  try {
    return StellarSdk.Keypair.fromSecret(secret);
  } catch {
    return null;
  }
}

function getReserveConfigs(): ReserveConfig[] {
  const raw = process.env.LP_RESERVE_CONFIGS;
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ReserveConfig[];
  } catch {
    console.warn("[lp-rebalance] Invalid LP_RESERVE_CONFIGS JSON");
    return [];
  }
}

async function getAssetBalance(
  server: StellarSdk.Horizon.Server,
  publicKey: string,
  assetCode: string,
  assetIssuer: string,
): Promise<number> {
  const account = await server.loadAccount(publicKey);
  for (const b of account.balances) {
    if (assetIssuer === "" && b.asset_type === "native") {
      return parseFloat(b.balance);
    }
    if (
      b.asset_type !== "native" &&
      (b as any).asset_code === assetCode &&
      (b as any).asset_issuer === assetIssuer
    ) {
      return parseFloat(b.balance);
    }
  }
  return 0;
}

/**
 * Execute a path payment through Stellar's liquidity pools to top up a reserve.
 * Sells the native XLM held in the distribution account to buy the target asset.
 */
async function executePathPayment(
  server: StellarSdk.Horizon.Server,
  keypair: StellarSdk.Keypair,
  destAsset: StellarSdk.Asset,
  destAmount: string,
): Promise<string> {
  const account = await server.loadAccount(keypair.publicKey());

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      StellarSdk.Operation.pathPaymentStrictReceive({
        sendAsset: StellarSdk.Asset.native(),
        // Allow up to 5 % slippage on the XLM side
        sendMax: String(Math.ceil(parseFloat(destAmount) * 1.05)),
        destination: keypair.publicKey(),
        destAsset,
        destAmount,
        path: [], // let Horizon find the best path through LPs
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const response = await server.submitTransaction(tx);
  return response.hash;
}

/**
 * Check all configured reserves and rebalance any that have fallen below
 * their minimum threshold by executing path payments via Stellar LPs.
 */
export async function rebalanceReserves(): Promise<RebalanceResult[]> {
  const keypair = getDistributionKeypair();
  if (!keypair) {
    console.warn(
      "[lp-rebalance] STELLAR_DISTRIBUTION_SECRET not configured — skipping",
    );
    return [];
  }

  const configs = getReserveConfigs();
  if (configs.length === 0) {
    console.log("[lp-rebalance] No reserve configs found");
    return [];
  }

  const server = getStellarServer();
  const results: RebalanceResult[] = [];

  for (const cfg of configs) {
    const balance = await getAssetBalance(
      server,
      keypair.publicKey(),
      cfg.assetCode,
      cfg.assetIssuer,
    );

    if (balance >= cfg.minReserve) {
      results.push({
        assetCode: cfg.assetCode,
        currentBalance: balance,
        targetReserve: cfg.targetReserve,
        amountSwapped: 0,
        txHash: null,
        skipped: true,
        reason: `balance ${balance} >= minReserve ${cfg.minReserve}`,
      });
      continue;
    }

    const deficit = cfg.targetReserve - balance;
    console.log(
      `[lp-rebalance] ${cfg.assetCode} balance=${balance} below min=${cfg.minReserve}, buying ${deficit}`,
    );

    try {
      const destAsset =
        cfg.assetIssuer === ""
          ? StellarSdk.Asset.native()
          : new StellarSdk.Asset(cfg.assetCode, cfg.assetIssuer);

      const txHash = await executePathPayment(
        server,
        keypair,
        destAsset,
        String(deficit),
      );

      results.push({
        assetCode: cfg.assetCode,
        currentBalance: balance,
        targetReserve: cfg.targetReserve,
        amountSwapped: deficit,
        txHash,
        skipped: false,
      });
    } catch (err) {
      console.error(
        `[lp-rebalance] Path payment failed for ${cfg.assetCode}:`,
        err,
      );
      results.push({
        assetCode: cfg.assetCode,
        currentBalance: balance,
        targetReserve: cfg.targetReserve,
        amountSwapped: 0,
        txHash: null,
        skipped: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
