import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import axios from "axios";
import { printError } from "../dashboard";

export interface ProviderFloatResult {
  provider: string;
  currency: string;
  currentBalance: number;
  status: "OK" | "LOW_FLOAT" | "ERROR" | "UNAVAILABLE";
  latencyMs?: number;
  error?: string;
}

export interface ProviderEndpointConfig {
  name: "MTN" | "Orange" | "Airtel" | "M-Pesa" | "EcoCash";
  currency: string;
  endpointUrl: string;
  envUrlKey: string;
  minThreshold: number;
}

export const DEFAULT_FLOAT_PROVIDERS: ProviderEndpointConfig[] = [
  {
    name: "MTN",
    currency: "UGX",
    endpointUrl: "https://sandbox.momodeveloper.mtn.com/collection/v1_0/account/balance",
    envUrlKey: "MTN_FLOAT_BALANCE_URL",
    minThreshold: 100_000,
  },
  {
    name: "Orange",
    currency: "XAF",
    endpointUrl: "https://api.orange.com/orange-money-webpay/dev/v1/account/balance",
    envUrlKey: "ORANGE_FLOAT_BALANCE_URL",
    minThreshold: 50_000,
  },
  {
    name: "Airtel",
    currency: "UGX",
    endpointUrl: "https://openapi.airtel.africa/standard/v1/users/balance",
    envUrlKey: "AIRTEL_FLOAT_BALANCE_URL",
    minThreshold: 100_000,
  },
  {
    name: "M-Pesa",
    currency: "KES",
    endpointUrl: "https://sandbox.safaricom.co.ke/mpesa/accountbalance/v1/query",
    envUrlKey: "MPESA_FLOAT_BALANCE_URL",
    minThreshold: 10_000,
  },
  {
    name: "EcoCash",
    currency: "USD",
    endpointUrl: "https://ecocash.example.test/merchant/v1/balance",
    envUrlKey: "ECOCASH_FLOAT_BALANCE_URL",
    minThreshold: 500,
  },
];

export interface FloatCheckOptions {
  json?: boolean;
  timeout?: number;
  threshold?: number;
}

export type CustomProviderFetcher = (
  provider: ProviderEndpointConfig,
) => Promise<{ balance: number; currency?: string; status?: "OK" | "LOW_FLOAT" | "ERROR" | "UNAVAILABLE" }>;

/**
 * Fetches real-time float balance for a single provider.
 */
export async function fetchProviderFloat(
  provider: ProviderEndpointConfig,
  customFetcher?: CustomProviderFetcher,
  timeoutMs = 5000,
): Promise<ProviderFloatResult> {
  const startTime = Date.now();
  const url = process.env[provider.envUrlKey] || provider.endpointUrl;

  try {
    if (customFetcher) {
      const customRes = await customFetcher(provider);
      const latencyMs = Date.now() - startTime;
      const currency = customRes.currency || provider.currency;
      const balance = Number(customRes.balance);
      const threshold = provider.minThreshold;
      const status =
        customRes.status ||
        (balance < threshold ? "LOW_FLOAT" : "OK");

      return {
        provider: provider.name,
        currency,
        currentBalance: balance,
        status,
        latencyMs,
      };
    }

    const response = await axios.get(url, {
      timeout: timeoutMs,
      headers: {
        Accept: "application/json",
        ...(process.env[`${provider.name.toUpperCase().replace(/[^A-Z]/g, "")}_API_KEY`]
          ? {
              Authorization: `Bearer ${
                process.env[`${provider.name.toUpperCase().replace(/[^A-Z]/g, "")}_API_KEY`]
              }`,
            }
          : {}),
      },
    });

    const latencyMs = Date.now() - startTime;
    const data = response.data || {};
    const rawBalance =
      data.availableBalance ??
      data.balance ??
      data.currentBalance ??
      data.data?.availableBalance ??
      data.data?.balance ??
      0;

    const balance = Number(rawBalance);
    const currency = data.currency || data.data?.currency || provider.currency;
    const threshold = provider.minThreshold;
    const status = balance < threshold ? "LOW_FLOAT" : "OK";

    return {
      provider: provider.name,
      currency,
      currentBalance: balance,
      status,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    return {
      provider: provider.name,
      currency: provider.currency,
      currentBalance: 0,
      status: "ERROR",
      latencyMs,
      error: message,
    };
  }
}

/**
 * Queries balance endpoints concurrently across all configured mobile money partners.
 */
export async function queryAllFloatBalances(
  providers: ProviderEndpointConfig[] = DEFAULT_FLOAT_PROVIDERS,
  customFetchers?: Record<string, CustomProviderFetcher>,
  options: { timeoutMs?: number } = {},
): Promise<ProviderFloatResult[]> {
  const timeoutMs = options.timeoutMs ?? 5000;

  // Execute all requests concurrently using Promise.all
  return Promise.all(
    providers.map((p) => fetchProviderFloat(p, customFetchers?.[p.name], timeoutMs)),
  );
}

/**
 * Renders the float check results into a formatted console table.
 */
export function buildFloatCheckTable(results: ProviderFloatResult[]): string {
  const table = new Table({
    head: [
      chalk.cyan("Provider"),
      chalk.cyan("Currency"),
      chalk.cyan("Current Balance"),
      chalk.cyan("Status"),
    ],
    colAligns: ["left", "center", "right", "center"],
  });

  for (const r of results) {
    const formattedBalance =
      typeof r.currentBalance === "number"
        ? r.currentBalance.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        : String(r.currentBalance);

    let statusStyled = chalk.green("OK");
    if (r.status === "LOW_FLOAT") {
      statusStyled = chalk.yellow("LOW_FLOAT");
    } else if (r.status === "ERROR" || r.status === "UNAVAILABLE") {
      statusStyled = chalk.red(r.status);
    }

    table.push([
      chalk.bold(r.provider),
      chalk.yellow(r.currency),
      chalk.white(formattedBalance),
      statusStyled,
    ]);
  }

  return table.toString();
}

/**
 * Command runner handling data fetching, table rendering or JSON output.
 */
export async function executeFloatCheck(
  options: FloatCheckOptions = {},
  providers: ProviderEndpointConfig[] = DEFAULT_FLOAT_PROVIDERS,
  customFetchers?: Record<string, CustomProviderFetcher>,
): Promise<ProviderFloatResult[]> {
  const results = await queryAllFloatBalances(providers, customFetchers, {
    timeoutMs: options.timeout,
  });

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return results;
  }

  console.log(`\n${chalk.bold("Real-Time Mobile Money Float Balances")}`);
  console.log(buildFloatCheckTable(results));

  const errorCount = results.filter((r) => r.status === "ERROR").length;
  const lowFloatCount = results.filter((r) => r.status === "LOW_FLOAT").length;

  if (errorCount > 0) {
    console.log(
      chalk.red(`\n⚠  ${errorCount} provider(s) failed float check query.`),
    );
  }
  if (lowFloatCount > 0) {
    console.log(
      chalk.yellow(`\n⚠  ${lowFloatCount} provider(s) have low operational float balance.`),
    );
  }
  if (errorCount === 0 && lowFloatCount === 0) {
    console.log(chalk.green("\n✓ All telecom float balances healthy.\n"));
  }

  return results;
}

/**
 * Registers 'momo-cli float:check' command on commander program.
 */
export function registerFloatCheckCommand(program: Command): void {
  program
    .command("float:check")
    .description(
      "Display real-time float account balances across all telecom partners (MTN, Orange, Airtel, M-Pesa, EcoCash)",
    )
    .option("--json", "Output machine-readable JSON format")
    .option("-t, --timeout <timeoutMs>", "Request timeout per provider in ms", (val) => parseInt(val, 10))
    .action(async (options: FloatCheckOptions) => {
      try {
        await executeFloatCheck(options);
      } catch (err) {
        printError(
          "Failed to fetch telecom partner float balances",
          err instanceof Error ? err : undefined,
          "ERR_FLOAT_CHECK",
        );
        process.exit(1);
      }
    });
}

