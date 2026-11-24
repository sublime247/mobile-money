import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import * as StellarSdk from "@stellar/stellar-sdk";
import { printError } from "../dashboard";
import { formatSuccess, formatWarn, formatInfo } from "../utils/cliFormatting";

/**
 * `momo-cli wallet:rotate` - automated hot wallet key rotation rehearsal
 * (#2361).
 *
 * This talks to Horizon directly (mirroring the backend's
 * src/services/stellar/assetService.ts conventions for trustline/balance
 * checks and TransactionBuilder usage) rather than going through the
 * backend HTTP API like the other CLI commands in this package, because hot
 * wallet rotation needs direct, auditable control over which Stellar
 * operations are built and signed - there is no existing
 * `/api/admin/wallet/rotate` endpoint to proxy to, and introducing one
 * would move the signing key handling into the backend process, which is a
 * materially different (and larger) design decision than this CLI command.
 */

export interface RotationAsset {
  /** Asset code, or "XLM" for native. */
  code: string;
  /** Required for non-native assets. */
  issuer?: string;
}

export interface WalletRotateOptions {
  oldSecretKey: string;
  newPublicKey: string;
  assets: RotationAsset[];
  horizonUrl: string;
  networkPassphrase: string;
  dryRun: boolean;
}

export interface TrustlineCheckResult {
  asset: RotationAsset;
  hasTrustline: boolean;
}

export interface PreflightReport {
  newWalletFunded: boolean;
  newWalletSequence: string | null;
  trustlineChecks: TrustlineCheckResult[];
  oldWalletBalances: Record<string, string>;
  /** True only when every check above passes and rotation can proceed. */
  readyToRotate: boolean;
  /** Human-readable reasons readyToRotate is false, empty when it's true. */
  blockers: string[];
}

export interface TransferStep {
  asset: RotationAsset;
  amount: string;
  txHash?: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface RotationResult {
  preflight: PreflightReport;
  transfers: TransferStep[];
  /** Sequence number of the new wallet observed immediately after the transfers, to prove continuity. */
  finalSequence: string | null;
  dryRun: boolean;
}

function buildAsset(asset: RotationAsset): StellarSdk.Asset {
  if (asset.code.toUpperCase() === "XLM") return StellarSdk.Asset.native();
  if (!asset.issuer) {
    throw new Error(`Asset ${asset.code} requires an issuer account id`);
  }
  return new StellarSdk.Asset(asset.code, asset.issuer);
}

function assetKey(asset: RotationAsset): string {
  return asset.code.toUpperCase() === "XLM"
    ? "XLM"
    : `${asset.code}:${asset.issuer}`;
}

/**
 * Runs every pre-flight validation check before any fund transfer or config
 * change is attempted: the new wallet must exist (be funded) on the
 * network, and must already hold a trustline for every non-native asset
 * being transferred (trustlines cannot be created for an account by
 * anyone other than that account's own signer, so this command can only
 * verify - not establish - them; see readyToRotate/blockers for how a
 * missing trustline is surfaced).
 */
export async function runPreflightChecks(
  server: InstanceType<typeof StellarSdk.Horizon.Server>,
  options: Pick<WalletRotateOptions, "newPublicKey" | "assets">,
  oldPublicKey: string,
): Promise<PreflightReport> {
  const blockers: string[] = [];
  let newWalletFunded = false;
  let newWalletSequence: string | null = null;
  const trustlineChecks: TrustlineCheckResult[] = [];
  const oldWalletBalances: Record<string, string> = {};

  let newAccount: Awaited<ReturnType<typeof server.loadAccount>> | null = null;
  try {
    newAccount = await server.loadAccount(options.newPublicKey);
    newWalletFunded = true;
    newWalletSequence = newAccount.sequenceNumber();
  } catch {
    blockers.push(
      `New wallet ${options.newPublicKey} is not funded (no Horizon account found). ` +
        `Fund it with at least the minimum XLM reserve before rotating.`,
    );
  }

  for (const asset of options.assets) {
    if (asset.code.toUpperCase() === "XLM") {
      trustlineChecks.push({ asset, hasTrustline: true });
      continue;
    }

    const hasTrustline =
      newAccount !== null &&
      newAccount.balances.some(
        (b) =>
          b.asset_type !== "native" &&
          "asset_code" in b &&
          b.asset_code === asset.code &&
          "asset_issuer" in b &&
          b.asset_issuer === asset.issuer,
      );
    trustlineChecks.push({ asset, hasTrustline });

    if (newAccount && !hasTrustline) {
      blockers.push(
        `New wallet is missing a trustline for ${asset.code}:${asset.issuer}. ` +
          `Establish it from the new wallet's own signer (changeTrust) before rotating.`,
      );
    }
  }

  try {
    const oldAccount = await server.loadAccount(oldPublicKey);
    for (const balance of oldAccount.balances) {
      if (balance.asset_type === "native") {
        oldWalletBalances.XLM = balance.balance;
      } else if ("asset_code" in balance && "asset_issuer" in balance) {
        oldWalletBalances[`${balance.asset_code}:${balance.asset_issuer}`] =
          balance.balance;
      }
    }
  } catch {
    blockers.push(
      `Old wallet ${oldPublicKey} could not be loaded from Horizon.`,
    );
  }

  return {
    newWalletFunded,
    newWalletSequence,
    trustlineChecks,
    oldWalletBalances,
    readyToRotate: blockers.length === 0,
    blockers,
  };
}

/**
 * Transfers the operational float of every requested asset from the old
 * wallet to the new wallet. Each asset is sent as its own payment operation
 * in a single transaction so a partial trustline problem for one asset
 * doesn't block the others from being attempted independently (the
 * transaction as a whole still succeeds or fails atomically per Stellar's
 * normal semantics - this only affects how transfers are grouped, not
 * atomicity).
 *
 * In `--dry-run`, no transaction is built or submitted; every transfer is
 * reported as skipped with the amount that *would* have been sent.
 */
export async function transferFloat(
  server: InstanceType<typeof StellarSdk.Horizon.Server>,
  oldKeypair: StellarSdk.Keypair,
  options: Pick<
    WalletRotateOptions,
    "newPublicKey" | "networkPassphrase" | "dryRun"
  >,
  preflight: PreflightReport,
): Promise<TransferStep[]> {
  const steps: TransferStep[] = [];

  const transferable = preflight.trustlineChecks.filter((c) => c.hasTrustline);

  if (options.dryRun) {
    for (const check of transferable) {
      const key = assetKey(check.asset);
      const amount = preflight.oldWalletBalances[key] ?? "0";
      steps.push({
        asset: check.asset,
        amount,
        skipped: true,
        skipReason: "dry-run: no transaction submitted",
      });
    }
    return steps;
  }

  const oldAccount = await server.loadAccount(oldKeypair.publicKey());
  const txBuilder = new StellarSdk.TransactionBuilder(oldAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: options.networkPassphrase,
  });

  let hasOperations = false;
  for (const check of transferable) {
    const key = assetKey(check.asset);
    const rawBalance = preflight.oldWalletBalances[key];

    if (!rawBalance || Number(rawBalance) <= 0) {
      steps.push({
        asset: check.asset,
        amount: "0",
        skipped: true,
        skipReason: "zero balance on old wallet",
      });
      continue;
    }

    // Native XLM must keep enough above the account's minimum reserve to
    // remain a valid Stellar account (avoid a failed/underfunded sweep that
    // leaves the old wallet unable to pay its own transaction fee).
    const reserveBuffer = check.asset.code.toUpperCase() === "XLM" ? 2 : 0;
    const sendable = Math.max(0, Number(rawBalance) - reserveBuffer);
    if (sendable <= 0) {
      steps.push({
        asset: check.asset,
        amount: "0",
        skipped: true,
        skipReason: "balance does not exceed the minimum reserve buffer",
      });
      continue;
    }

    txBuilder.addOperation(
      StellarSdk.Operation.payment({
        destination: options.newPublicKey,
        asset: buildAsset(check.asset),
        amount: sendable.toFixed(7),
      }),
    );
    steps.push({ asset: check.asset, amount: sendable.toFixed(7) });
    hasOperations = true;
  }

  if (!hasOperations) {
    return steps;
  }

  const tx = txBuilder.setTimeout(60).build();
  tx.sign(oldKeypair);
  const response = await server.submitTransaction(tx);

  for (const step of steps) {
    if (!step.skipped) {
      step.txHash = response.hash;
    }
  }

  return steps;
}

/**
 * Orchestrates the full rotation rehearsal: pre-flight checks, operational
 * float transfer, and a final sequence-number continuity read. Does not
 * itself persist any configuration change - the caller (the CLI action
 * below) is responsible for that, after the human confirms the printed
 * verification report.
 */
export async function rotateWallet(
  options: WalletRotateOptions,
): Promise<RotationResult> {
  const server = new StellarSdk.Horizon.Server(options.horizonUrl);
  const oldKeypair = StellarSdk.Keypair.fromSecret(options.oldSecretKey);

  const preflight = await runPreflightChecks(
    server,
    { newPublicKey: options.newPublicKey, assets: options.assets },
    oldKeypair.publicKey(),
  );

  if (!preflight.readyToRotate) {
    return {
      preflight,
      transfers: [],
      finalSequence: preflight.newWalletSequence,
      dryRun: options.dryRun,
    };
  }

  const transfers = await transferFloat(
    server,
    oldKeypair,
    {
      newPublicKey: options.newPublicKey,
      networkPassphrase: options.networkPassphrase,
      dryRun: options.dryRun,
    },
    preflight,
  );

  let finalSequence = preflight.newWalletSequence;
  if (!options.dryRun) {
    try {
      const refreshed = await server.loadAccount(options.newPublicKey);
      finalSequence = refreshed.sequenceNumber();
    } catch {
      // Leave finalSequence at the pre-transfer value; the verification
      // report below will surface this as a sequence-continuity concern.
    }
  }

  return { preflight, transfers, finalSequence, dryRun: options.dryRun };
}

function printVerificationReport(result: RotationResult): void {
  const { preflight, transfers } = result;

  console.log(`\n${chalk.bold("Wallet Rotation — Verification Report")}`);
  console.log(chalk.dim("─".repeat(60)));

  console.log(
    `${chalk.bold("New wallet funded:")} ${
      preflight.newWalletFunded ? chalk.green("yes") : chalk.red("no")
    }`,
  );
  console.log(
    `${chalk.bold("New wallet sequence (pre-transfer):")} ${
      preflight.newWalletSequence ?? chalk.red("unavailable")
    }`,
  );

  console.log(`\n${chalk.bold("Trustline checks:")}`);
  for (const check of preflight.trustlineChecks) {
    const icon = check.hasTrustline ? chalk.green("✓") : chalk.red("✗");
    console.log(`  ${icon} ${check.asset.code}`);
  }

  if (preflight.blockers.length > 0) {
    console.log(`\n${chalk.bold.red("Blockers:")}`);
    for (const blocker of preflight.blockers) {
      console.log(`  ${chalk.red("✗")} ${blocker}`);
    }
  }

  if (transfers.length > 0) {
    console.log(`\n${chalk.bold("Transfers:")}`);
    for (const transfer of transfers) {
      if (transfer.skipped) {
        console.log(
          `  ${chalk.yellow("–")} ${transfer.asset.code}: skipped (${transfer.skipReason})`,
        );
      } else {
        console.log(
          `  ${chalk.green("✓")} ${transfer.asset.code}: ${transfer.amount}` +
            (transfer.txHash ? ` (tx ${transfer.txHash.slice(0, 12)}…)` : ""),
        );
      }
    }
  }

  console.log(
    `\n${chalk.bold("New wallet sequence (post-transfer):")} ${
      result.finalSequence ?? chalk.red("unavailable")
    }`,
  );
  if (preflight.newWalletSequence && result.finalSequence && !result.dryRun) {
    const advanced =
      BigInt(result.finalSequence) > BigInt(preflight.newWalletSequence);
    console.log(
      `${chalk.bold("Sequence continuity:")} ${
        advanced
          ? chalk.green("confirmed (sequence advanced)")
          : chalk.yellow("unchanged")
      }`,
    );
  }

  console.log(chalk.dim("─".repeat(60)));
}

export function registerWalletRotateCommand(program: Command): void {
  const wallet = program.command("wallet").description("Hot wallet management");

  wallet
    .command("rotate")
    .description(
      "Rehearse or execute hot wallet key rotation: validate the new wallet, " +
        "transfer operational float, and verify sequence continuity",
    )
    .requiredOption(
      "--new-public-key <key>",
      "Public key (G...) of the new hot wallet to rotate into",
    )
    .option(
      "--old-secret-key <key>",
      "Secret key (S...) of the current hot wallet. Falls back to HOT_WALLET_SECRET_KEY.",
    )
    .option(
      "--assets <codes>",
      "Comma-separated asset codes to transfer (e.g. XLM,USDC). Defaults to XLM only.",
      "XLM",
    )
    .option(
      "--asset-issuer <issuer>",
      "Issuer account id for non-native assets listed in --assets (required if any non-XLM asset is given)",
    )
    .option(
      "--horizon-url <url>",
      "Horizon server URL. Falls back to STELLAR_HORIZON_URL, then the public testnet.",
    )
    .option(
      "--dry-run",
      "Run every check and report what would happen, without transferring funds or changing config",
    )
    .option(
      "--yes",
      "Skip the interactive confirmation prompt (for non-interactive/CI rehearsals)",
    )
    .action(
      async (opts: {
        newPublicKey: string;
        oldSecretKey?: string;
        assets: string;
        assetIssuer?: string;
        horizonUrl?: string;
        dryRun?: boolean;
        yes?: boolean;
      }) => {
        try {
          const oldSecretKey =
            opts.oldSecretKey ?? process.env.HOT_WALLET_SECRET_KEY;
          if (!oldSecretKey) {
            printError(
              "--old-secret-key or HOT_WALLET_SECRET_KEY is required",
              undefined,
              "ERR_WALLET_ROTATE",
            );
            process.exit(1);
          }

          if (
            !opts.newPublicKey.startsWith("G") ||
            opts.newPublicKey.length !== 56
          ) {
            printError(
              "--new-public-key must be a valid Stellar public key (G...)",
              undefined,
              "ERR_WALLET_ROTATE",
            );
            process.exit(1);
          }

          const assetCodes = opts.assets
            .split(",")
            .map((code) => code.trim())
            .filter((code) => code.length > 0);
          const assets: RotationAsset[] = assetCodes.map((code) => ({
            code,
            issuer: code.toUpperCase() === "XLM" ? undefined : opts.assetIssuer,
          }));

          const nonNativeWithoutIssuer = assets.find(
            (a) => a.code.toUpperCase() !== "XLM" && !a.issuer,
          );
          if (nonNativeWithoutIssuer) {
            printError(
              `--asset-issuer is required for non-native asset ${nonNativeWithoutIssuer.code}`,
              undefined,
              "ERR_WALLET_ROTATE",
            );
            process.exit(1);
          }

          const horizonUrl =
            opts.horizonUrl ??
            process.env.STELLAR_HORIZON_URL ??
            "https://horizon-testnet.stellar.org";
          const networkPassphrase =
            process.env.STELLAR_NETWORK === "mainnet"
              ? StellarSdk.Networks.PUBLIC
              : StellarSdk.Networks.TESTNET;

          console.log(formatInfo("Running pre-flight checks against Horizon…"));

          const dryRun = opts.dryRun ?? false;

          if (!dryRun && !opts.yes) {
            const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>(
              [
                {
                  type: "confirm",
                  name: "confirmed",
                  message: chalk.red(
                    "This will transfer operational float from the current hot wallet " +
                      "to the new wallet and is not reversible from this CLI. Continue?",
                  ),
                  default: false,
                },
              ],
            );

            if (!confirmed) {
              console.log(chalk.yellow("Aborted."));
              process.exit(0);
            }
          }

          const result = await rotateWallet({
            oldSecretKey,
            newPublicKey: opts.newPublicKey,
            assets,
            horizonUrl,
            networkPassphrase,
            dryRun,
          });

          printVerificationReport(result);

          if (!result.preflight.readyToRotate) {
            console.log(
              formatWarn(
                "\nPre-flight checks failed — no funds were transferred and no config was changed.",
              ),
            );
            process.exit(1);
          }

          if (dryRun) {
            console.log(
              formatWarn(
                "\nDry-run mode — no funds were transferred and no config was changed.",
              ),
            );
            return;
          }

          console.log(
            formatSuccess(
              "\nFloat transfer complete. Update HOT_WALLET_SECRET_KEY / HOT_WALLET_PUBLIC_KEY " +
                "in your configuration store to point at the new wallet, then decommission the old one.",
            ),
          );
        } catch (err) {
          printError(
            `Wallet rotation failed: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err : undefined,
            "ERR_WALLET_ROTATE",
          );
          process.exit(1);
        }
      },
    );
}
