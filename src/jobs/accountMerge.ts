import * as StellarSdk from "stellar-sdk";
import { getNetworkPassphrase, getStellarServer } from "../config/stellar";

const ACCOUNT_MERGE_PREFIX = "[account-merge]";
const STROOPS_PER_XLM = 10_000_000n;
const BASE_FEE_STROOPS = BigInt(StellarSdk.BASE_FEE.toString());

export interface AccountMergeCandidate {
  nativeBalance: string;
  subentryCount: number;
  hasNonNativeBalances: boolean;
  lastActivityAt: Date | null;
}

export interface AccountMergeEvaluation {
  eligible: boolean;
  reason?: string;
  reclaimableBalance: string;
}

export function parseAuxiliaryAccountSecrets(
  value: string | undefined = process.env.STELLAR_AUXILIARY_ACCOUNT_SECRETS,
): string[] {
  if (!value) return [];

  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function resolveMergeDestinationPublicKey(
  destination: string | undefined = process.env
    .STELLAR_ACCOUNT_MERGE_DESTINATION,
  issuerSecret: string | undefined = process.env.STELLAR_ISSUER_SECRET,
): string | null {
  if (destination?.trim()) {
    const publicKey = destination.trim();
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
      throw new Error(
        "STELLAR_ACCOUNT_MERGE_DESTINATION must be a valid Stellar public key",
      );
    }
    return publicKey;
  }

  if (!issuerSecret?.trim()) return null;

  return StellarSdk.Keypair.fromSecret(issuerSecret.trim()).publicKey();
}

export function xlmToStroops(amount: string): bigint {
  const normalized = amount.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(normalized)) {
    throw new Error(`Invalid XLM amount: ${amount}`);
  }

  const [wholePart, fractionalPart = ""] = normalized.split(".");
  const paddedFraction = `${fractionalPart}0000000`.slice(0, 7);

  return BigInt(wholePart) * STROOPS_PER_XLM + BigInt(paddedFraction);
}

export function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = (stroops % STROOPS_PER_XLM)
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function evaluateAccountMergeCandidate(
  candidate: AccountMergeCandidate,
  inactivityDays: number,
  now: Date = new Date(),
): AccountMergeEvaluation {
  const nativeBalanceStroops = xlmToStroops(candidate.nativeBalance);
  const reclaimableStroops = nativeBalanceStroops - BASE_FEE_STROOPS;
  const reclaimableBalance =
    reclaimableStroops > 0n ? stroopsToXlm(reclaimableStroops) : "0";

  if (nativeBalanceStroops <= BASE_FEE_STROOPS) {
    return {
      eligible: false,
      reason: "native balance is too low to reclaim after fees",
      reclaimableBalance,
    };
  }

  if (candidate.subentryCount > 0) {
    return {
      eligible: false,
      reason: `account still has ${candidate.subentryCount} subentries`,
      reclaimableBalance,
    };
  }

  if (candidate.hasNonNativeBalances) {
    return {
      eligible: false,
      reason: "account still holds non-native assets",
      reclaimableBalance,
    };
  }

  if (candidate.lastActivityAt) {
    const inactivityCutoff = new Date(now);
    inactivityCutoff.setDate(inactivityCutoff.getDate() - inactivityDays);

    if (candidate.lastActivityAt > inactivityCutoff) {
      return {
        eligible: false,
        reason: `account was active within the last ${inactivityDays} day(s)`,
        reclaimableBalance,
      };
    }
  }

  return {
    eligible: true,
    reclaimableBalance,
  };
}

function getNativeBalance(
  account: StellarSdk.Horizon.ServerApi.AccountRecord,
): string {
  const nativeBalance = account.balances.find(
    (balance) => balance.asset_type === "native",
  );
  return nativeBalance?.balance ?? "0";
}

function hasNonNativeBalances(
  account: StellarSdk.Horizon.ServerApi.AccountRecord,
): boolean {
  return account.balances.some(
    (balance) =>
      balance.asset_type !== "native" && Number.parseFloat(balance.balance) > 0,
  );
}

async function fetchLastActivityAt(
  server: StellarSdk.Horizon.Server,
  publicKey: string,
): Promise<Date | null> {
  const response = await server
    .transactions()
    .forAccount(publicKey)
    .order("desc")
    .limit(1)
    .call();

  const latestTransaction = response.records[0];
  return latestTransaction ? new Date(latestTransaction.created_at) : null;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const maybeResponse = error as {
    response?: { status?: number };
  };

  return maybeResponse.response?.status === 404;
}

export async function runAccountMergeJob(): Promise<void> {
  const sourceSecrets = parseAuxiliaryAccountSecrets();
  if (sourceSecrets.length === 0) {
    console.log(`${ACCOUNT_MERGE_PREFIX} No auxiliary accounts configured`);
    return;
  }

  const destination = resolveMergeDestinationPublicKey();
  if (!destination) {
    console.log(
      `${ACCOUNT_MERGE_PREFIX} No merge destination configured; skipping run`,
    );
    return;
  }

  const inactivityDays = Number.parseInt(
    process.env.ACCOUNT_MERGE_INACTIVITY_DAYS || "30",
    10,
  );
  const dryRun = process.env.ACCOUNT_MERGE_DRY_RUN === "true";
  const server = getStellarServer();

  let mergedCount = 0;
  let skippedCount = 0;
  let reclaimedStroops = 0n;

  for (const secret of sourceSecrets) {
    let sourceKeypair: StellarSdk.Keypair;

    try {
      sourceKeypair = StellarSdk.Keypair.fromSecret(secret);
    } catch {
      skippedCount += 1;
      console.error(`${ACCOUNT_MERGE_PREFIX} Skipping invalid source secret`);
      continue;
    }

    const sourcePublicKey = sourceKeypair.publicKey();

    if (sourcePublicKey === destination) {
      skippedCount += 1;
      console.warn(
        `${ACCOUNT_MERGE_PREFIX} Skipping ${sourcePublicKey}: source matches destination`,
      );
      continue;
    }

    try {
      const account = await server.loadAccount(sourcePublicKey);
      const evaluation = evaluateAccountMergeCandidate(
        {
          nativeBalance: getNativeBalance(account),
          subentryCount: account.subentry_count,
          hasNonNativeBalances: hasNonNativeBalances(account),
          lastActivityAt: await fetchLastActivityAt(server, sourcePublicKey),
        },
        inactivityDays,
      );

      if (!evaluation.eligible) {
        skippedCount += 1;
        console.log(
          `${ACCOUNT_MERGE_PREFIX} Skipping ${sourcePublicKey}: ${evaluation.reason}`,
        );
        continue;
      }

      if (dryRun) {
        console.log(
          `${ACCOUNT_MERGE_PREFIX} Dry run: would merge ${sourcePublicKey} into ${destination} reclaiming ~${evaluation.reclaimableBalance} XLM`,
        );
        continue;
      }

      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: getNetworkPassphrase(),
      })
        .addOperation(
          StellarSdk.Operation.accountMerge({
            destination,
          }),
        )
        .setTimeout(60)
        .build();

      transaction.sign(sourceKeypair);

      const response = await server.submitTransaction(transaction);

      mergedCount += 1;
      reclaimedStroops += xlmToStroops(evaluation.reclaimableBalance);

      console.log(
        `${ACCOUNT_MERGE_PREFIX} Merged ${sourcePublicKey} into ${destination}; reclaimed ${evaluation.reclaimableBalance} XLM; tx=${response.hash}`,
      );
    } catch (error) {
      skippedCount += 1;

      if (isNotFoundError(error)) {
        console.warn(
          `${ACCOUNT_MERGE_PREFIX} Skipping ${sourcePublicKey}: account not found on Horizon`,
        );
        continue;
      }

      console.error(
        `${ACCOUNT_MERGE_PREFIX} Skipping ${sourcePublicKey}: merge attempt failed`,
        error,
      );
      continue;
    }
  }

  console.log(
    `${ACCOUNT_MERGE_PREFIX} Completed. merged=${mergedCount} skipped=${skippedCount} reclaimed=${stroopsToXlm(reclaimedStroops)} XLM`,
  );
}
