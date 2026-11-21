import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { printError } from "../dashboard";

export type ProviderStatus =
  "OK" | "AUTH_FAILED" | "UNREACHABLE" | "SSL_ERROR" | "TIMEOUT";

export interface ProviderConnectivityResult {
  provider: "MTN" | "Orange" | "Airtel" | "M-Pesa" | "Moov" | string;
  endpointUrl: string;
  latencyMs: number;
  status: ProviderStatus;
  authenticated: boolean;
  httpStatus?: number;
  error?: string;
}

export interface ProviderPingConfig {
  name: "MTN" | "Orange" | "Airtel" | "M-Pesa" | "Moov";
  url: string;
  isCritical: boolean;
}

export function getDefaultProviderConfigs(): ProviderPingConfig[] {
  return [
    {
      name: "MTN",
      url:
        process.env.MTN_BASE_URL ??
        process.env.MTN_HEALTH_URL ??
        "https://sandbox.momodeveloper.mtn.com/v1_0/apiuser",
      isCritical: true,
    },
    {
      name: "Orange",
      url:
        process.env.ORANGE_BASE_URL ??
        process.env.ORANGE_HEALTH_URL ??
        "https://api.orange.com/orange-money-webpay/dev/v1/webpayment",
      isCritical: true,
    },
    {
      name: "Airtel",
      url:
        process.env.AIRTEL_BASE_URL ??
        process.env.AIRTEL_HEALTH_URL ??
        "https://openapi.airtel.africa/auth/oauth2/token",
      isCritical: true,
    },
    {
      name: "M-Pesa",
      url:
        process.env.MPESA_BASE_URL ??
        process.env.MPESA_HEALTH_URL ??
        "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      isCritical: true,
    },
    {
      name: "Moov",
      url:
        process.env.MOOV_BASE_URL ??
        process.env.MOOV_HEALTH_URL ??
        "https://api.moov-africa.com/oauth/token",
      isCritical: true,
    },
  ];
}

export type FetchFunction = (
  url: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; ok: boolean }>;

export async function pingProvider(
  config: ProviderPingConfig,
  timeoutMs = 5000,
  fetchImpl?: FetchFunction,
): Promise<ProviderConnectivityResult> {
  const customFetch =
    fetchImpl ?? (globalThis.fetch as unknown as FetchFunction);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const res = await customFetch(config.url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "momo-cli/1.0.0",
      },
    });

    const latencyMs = Math.max(1, Date.now() - start);

    // 401 / 403 indicates authentication credentials failure
    if (res.status === 401 || res.status === 403) {
      return {
        provider: config.name,
        endpointUrl: config.url,
        latencyMs,
        status: "AUTH_FAILED",
        authenticated: false,
        httpStatus: res.status,
        error: `Authentication failed (HTTP ${res.status})`,
      };
    }

    return {
      provider: config.name,
      endpointUrl: config.url,
      latencyMs,
      status: "OK",
      authenticated: true,
      httpStatus: res.status,
    };
  } catch (err: unknown) {
    const latencyMs = Math.max(1, Date.now() - start);
    const errMessage = err instanceof Error ? err.message : String(err);
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" || /timeout/i.test(errMessage));
    const isSsl =
      /ssl|cert|tls|certificate/i.test(errMessage) ||
      (err as any)?.code === "CERT_HAS_EXPIRED" ||
      (err as any)?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE";

    const status: ProviderStatus = isSsl
      ? "SSL_ERROR"
      : isTimeout
        ? "TIMEOUT"
        : "UNREACHABLE";

    return {
      provider: config.name,
      endpointUrl: config.url,
      latencyMs,
      status,
      authenticated: false,
      error: errMessage,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildConnectivityTable(
  results: ProviderConnectivityResult[],
): string {
  const table = new Table({
    head: [
      chalk.cyan("Provider"),
      chalk.cyan("Endpoint URL"),
      chalk.cyan("Latency"),
      chalk.cyan("Status"),
    ],
  });

  for (const r of results) {
    const statusFormatted =
      r.status === "OK"
        ? chalk.green("OK")
        : r.status === "AUTH_FAILED"
          ? chalk.red.bold("AUTH_FAILED")
          : chalk.yellow(r.status);

    table.push([
      chalk.bold(r.provider),
      r.endpointUrl,
      `${r.latencyMs} ms`,
      statusFormatted,
    ]);
  }

  return table.toString();
}

export interface TestConnectivityOptions {
  json?: boolean;
  timeoutMs?: number;
  providers?: ProviderPingConfig[];
  fetchImpl?: FetchFunction;
}

export async function executeTestConnectivity(
  options: TestConnectivityOptions = {},
): Promise<{
  results: ProviderConnectivityResult[];
  hasAuthFailure: boolean;
  table: string;
  exitCode: number;
}> {
  const providers = options.providers ?? getDefaultProviderConfigs();
  const timeoutMs = options.timeoutMs ?? 5000;

  const results = await Promise.all(
    providers.map((p) => pingProvider(p, timeoutMs, options.fetchImpl)),
  );

  const hasAuthFailure = results.some(
    (r) => r.status === "AUTH_FAILED" || !r.authenticated,
  );
  const exitCode = hasAuthFailure ? 1 : 0;
  const table = buildConnectivityTable(results);

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  }

  return {
    results,
    hasAuthFailure,
    table,
    exitCode,
  };
}

export function registerTestConnectivityCommand(program: Command): void {
  program
    .command("provider:test-connectivity")
    .description(
      "Test outbound HTTPS connectivity, SSL certificate validity, and API authentication status across all configured telecom provider endpoints",
    )
    .option("--json", "Output machine-readable JSON format")
    .option(
      "--timeout <ms>",
      "Timeout per provider check in milliseconds",
      "5000",
    )
    .action(async (options: { json?: boolean; timeout?: string }) => {
      try {
        const timeoutMs = parseInt(options.timeout || "5000", 10);
        const { hasAuthFailure, table } = await executeTestConnectivity({
          json: options.json,
          timeoutMs,
        });

        if (!options.json) {
          console.log(table);
        }

        if (hasAuthFailure) {
          process.exit(1);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        printError(
          msg,
          err instanceof Error ? err : undefined,
          "ERR_CONNECTIVITY",
        );
        process.exit(1);
      }
    });
}
