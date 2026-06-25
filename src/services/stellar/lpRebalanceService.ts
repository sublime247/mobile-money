import logger from "../../utils/logger";
import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../../config/stellar";

export interface ReserveConfig {
  assetCode: string;
  assetIssuer: string; // empty string = native XLM
  minReserve: number; // trigger rebalance below this
  targetReserve: number;
  absoluteMinReserve?: number; // hard warning threshold
  rebalanceFromAssetCode?: string;
  rebalanceFromAssetIssuer?: string; // empty string = native XLM
  maxSlippagePct?: number;
}

export interface ReserveWarning {
  assetCode: string;
  currentBalance: number;
  absoluteMinReserve: number;
  message: string;
}

export interface RebalanceResult {
  assetCode: string;
  currentBalance: number;
  targetReserve: number;
  amountSwapped: number;
  txHash: string | null;
  skipped: boolean;
  reason?: string;
  warning?: ReserveWarning;
}

export interface RebalanceRunResult {
  txHash: string | null;
  atomic: boolean;
  results: RebalanceResult[];
  warnings: ReserveWarning[];
}

type HorizonServer = StellarSdk.Horizon.Server;
type RebalanceOperation = ReturnType<
  typeof StellarSdk.Operation.pathPaymentStrictReceive
>;

type StrictReceivePathRecord = {
  source_amount: string;
  path?: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
  }>;
};

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
    const parsed = JSON.parse(raw) as ReserveConfig[];
    return parsed.filter(
      (cfg) =>
        typeof cfg.assetCode === "string" &&
        typeof cfg.assetIssuer === "string" &&
        Number.isFinite(cfg.minReserve) &&
        Number.isFinite(cfg.targetReserve) &&
        cfg.targetReserve >= cfg.minReserve,
    );
  } catch {
    console.warn("[lp-rebalance] Invalid LP_RESERVE_CONFIGS JSON");
    return [];
  }
}

function toStellarAsset(
  assetCode: string,
  assetIssuer: string,
): StellarSdk.Asset {
  return assetIssuer === ""
    ? StellarSdk.Asset.native()
    : new StellarSdk.Asset(assetCode, assetIssuer);
}

function toAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid Stellar amount: ${value}`);
  }
  return value
    .toFixed(7)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1");
}

function pathRecordToAssets(
  record: StrictReceivePathRecord,
): StellarSdk.Asset[] {
  return (record.path ?? []).map((asset) =>
    asset.asset_type === "native"
      ? StellarSdk.Asset.native()
      : new StellarSdk.Asset(asset.asset_code ?? "", asset.asset_issuer ?? ""),
  );
}

async function getAssetBalance(
  server: HorizonServer,
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
      (b as StellarSdk.Horizon.HorizonApi.BalanceLineAsset).asset_code ===
        assetCode &&
      (b as StellarSdk.Horizon.HorizonApi.BalanceLineAsset).asset_issuer ===
        assetIssuer
    ) {
      return parseFloat(b.balance);
    }
  }
  return 0;
}

async function findStrictReceivePath(
  server: HorizonServer,
  sourceAsset: StellarSdk.Asset,
  destinationAsset: StellarSdk.Asset,
  destinationAmount: string,
): Promise<{ sendMax: string; path: StellarSdk.Asset[] }> {
  const pathsCall = server.strictReceivePaths(
    [sourceAsset],
    destinationAsset,
    destinationAmount,
  );
  const records = (await pathsCall.call()).records as StrictReceivePathRecord[];
  const best = records
    .filter((record) => Number(record.source_amount) > 0)
    .sort((a, b) => Number(a.source_amount) - Number(b.source_amount))[0];

  if (!best) {
    throw new Error(
      `No Stellar liquidity path found for ${sourceAsset.getCode()} -> ${destinationAsset.getCode()}`,
    );
  }

  return { sendMax: best.source_amount, path: pathRecordToAssets(best) };
}

async function buildRebalanceOperation(
  server: HorizonServer,
  keypair: StellarSdk.Keypair,
  cfg: ReserveConfig,
  deficit: number,
): Promise<RebalanceOperation> {
  const destAsset = toStellarAsset(cfg.assetCode, cfg.assetIssuer);
  const sendAsset = toStellarAsset(
    cfg.rebalanceFromAssetCode ?? "XLM",
    cfg.rebalanceFromAssetIssuer ?? "",
  );
  const destAmount = toAmount(deficit);
  const quote = await findStrictReceivePath(
    server,
    sendAsset,
    destAsset,
    destAmount,
  );
  const slippageMultiplier = 1 + (cfg.maxSlippagePct ?? 5) / 100;
  const sendMax = toAmount(Number(quote.sendMax) * slippageMultiplier);

  return StellarSdk.Operation.pathPaymentStrictReceive({
    sendAsset,
    sendMax,
    destination: keypair.publicKey(),
    destAsset,
    destAmount,
    path: quote.path,
  });
}

async function submitAtomicRebalance(
  server: HorizonServer,
  keypair: StellarSdk.Keypair,
  operations: RebalanceOperation[],
): Promise<string> {
  const account = await server.loadAccount(keypair.publicKey());
  let builder = new StellarSdk.TransactionBuilder(account, {
    fee: String(Number(StellarSdk.BASE_FEE) * operations.length),
    networkPassphrase: getNetworkPassphrase(),
  });

  for (const operation of operations) {
    builder = builder.addOperation(operation);
  }

  const tx = builder.setTimeout(30).build();
  tx.sign(keypair);
  const response = await server.submitTransaction(tx);
  return response.hash;
}

/**
 * Check configured reserves, warn on absolute threshold breaches, and submit
 * all required AMM path payments in one Stellar transaction. Because all swaps
 * are operations in a single transaction, either every reserve top-up succeeds
 * or no reserve is changed.
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
  const warnings: ReserveWarning[] = [];
  const pending: Array<{
    cfg: ReserveConfig;
    deficit: number;
    operation: RebalanceOperation;
  }> = [];

  for (const cfg of configs) {
    const balance = await getAssetBalance(
      server,
      keypair.publicKey(),
      cfg.assetCode,
      cfg.assetIssuer,
    );
    const warning =
      cfg.absoluteMinReserve !== undefined && balance < cfg.absoluteMinReserve
        ? {
            assetCode: cfg.assetCode,
            currentBalance: balance,
            absoluteMinReserve: cfg.absoluteMinReserve,
            message: `${cfg.assetCode} reserve ${balance} is below absolute threshold ${cfg.absoluteMinReserve}`,
          }
        : undefined;

    if (warning) {
      warnings.push(warning);
      console.warn(`[lp-rebalance] ${warning.message}`);
    }

    if (balance >= cfg.minReserve) {
      results.push({
        assetCode: cfg.assetCode,
        currentBalance: balance,
        targetReserve: cfg.targetReserve,
        amountSwapped: 0,
        txHash: null,
        skipped: true,
        warning,
        reason: `balance ${balance} >= minReserve ${cfg.minReserve}`,
      });
      continue;
    }

    const deficit = cfg.targetReserve - balance;
    try {
      pending.push({
        cfg,
        deficit,
        operation: await buildRebalanceOperation(server, keypair, cfg, deficit),
      });
      results.push({
        assetCode: cfg.assetCode,
        currentBalance: balance,
        targetReserve: cfg.targetReserve,
        amountSwapped: deficit,
        txHash: null,
        skipped: false,
        warning,
      });
    } catch (err) {
      logger.error(`[lp-rebalance] Path payment failed for ${cfg.assetCode}:`, err);
      results.push({
        assetCode: cfg.assetCode,
        currentBalance: balance,
        targetReserve: cfg.targetReserve,
        amountSwapped: 0,
        txHash: null,
        skipped: true,
        warning,
        reason,
      });
    }
  }

  if (pending.length === 0) {
    return results;
  }

  const txHash = await submitAtomicRebalance(
    server,
    keypair,
    pending.map((item) => item.operation),
  );

  for (const result of results) {
    if (!result.skipped && result.amountSwapped > 0) {
      result.txHash = txHash;
    }
  }

  return results;
}
