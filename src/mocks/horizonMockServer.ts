import express, { Request, Response, NextFunction } from "express";
import { Server } from "http";

export type HorizonOutageMode =
  | "none"
  | "offline"
  | "503_service_unavailable"
  | "500_internal_error"
  | "429_rate_limit"
  | "timeout"
  | "flaky";

export interface HorizonChaosConfig {
  outageMode: HorizonOutageMode;
  delayMs: number;
  errorRate: number;
  rateLimitAfter: number;
  retryAfterSeconds: number;
  simulatedDisconnect: boolean;
}

export interface MockAccountData {
  accountId: string;
  sequence: string;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    limit?: string;
  }>;
  subentryCount?: number;
  inflationDestination?: string;
  thresholds?: { low_threshold: number; med_threshold: number; high_threshold: number };
  flags?: { auth_required: boolean; auth_revocable: boolean; auth_immutable: boolean };
  signers?: Array<{ weight: number; key: string; type: string }>;
}

const DEFAULT_CHAOS: HorizonChaosConfig = {
  outageMode: "none",
  delayMs: 0,
  errorRate: 0,
  rateLimitAfter: Number.MAX_SAFE_INTEGER,
  retryAfterSeconds: 5,
  simulatedDisconnect: false,
};

let activeChaos: HorizonChaosConfig = { ...DEFAULT_CHAOS };
let requestCounter = 0;
const customAccounts = new Map<string, MockAccountData>();

export function setHorizonChaos(control: Partial<HorizonChaosConfig>): void {
  activeChaos = { ...activeChaos, ...control };
}

export function resetHorizonChaos(): void {
  activeChaos = { ...DEFAULT_CHAOS };
  requestCounter = 0;
}

export function getHorizonChaos(): HorizonChaosConfig {
  return { ...activeChaos };
}

export function setMockAccount(accountId: string, data: Partial<MockAccountData>): void {
  const existing = customAccounts.get(accountId) || {
    accountId,
    sequence: "100000000000000",
    balances: [{ asset_type: "native", balance: "10000.0000000" }],
  };
  customAccounts.set(accountId, { ...existing, ...data });
}

export function resetMockAccounts(): void {
  customAccounts.clear();
}

export function getRequestCount(): number {
  return requestCounter;
}

async function applyChaosMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  requestCounter++;

  if (activeChaos.simulatedDisconnect || activeChaos.outageMode === "offline") {
    res.destroy();
    return;
  }

  if (activeChaos.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, activeChaos.delayMs));
  }

  if (activeChaos.outageMode === "timeout") {
    // Hang request until timeout
    await new Promise((resolve) => setTimeout(resolve, 60000));
    return;
  }

  if (
    activeChaos.outageMode === "429_rate_limit" ||
    requestCounter > activeChaos.rateLimitAfter
  ) {
    res.set("Retry-After", String(activeChaos.retryAfterSeconds));
    res.status(429).json({
      type: "https://stellar.org/horizon-errors/rate_limit_exceeded",
      title: "Rate Limit Exceeded",
      status: 429,
      detail: "Rate limit exceeded. Please retry after delay.",
    });
    return;
  }

  if (activeChaos.outageMode === "503_service_unavailable") {
    res.status(503).json({
      type: "https://stellar.org/horizon-errors/service_unavailable",
      title: "Service Unavailable",
      status: 503,
      detail: "Mock Horizon server is down for network outage simulation.",
    });
    return;
  }

  if (activeChaos.outageMode === "500_internal_error") {
    res.status(500).json({
      type: "https://stellar.org/horizon-errors/server_error",
      title: "Internal Server Error",
      status: 500,
      detail: "Mock Horizon internal error simulation.",
    });
    return;
  }

  if (
    activeChaos.outageMode === "flaky" &&
    activeChaos.errorRate > 0 &&
    Math.random() < activeChaos.errorRate
  ) {
    res.status(503).json({
      type: "https://stellar.org/horizon-errors/service_unavailable",
      title: "Service Unavailable (Flaky Network)",
      status: 503,
      detail: "Flaky network outage simulation.",
    });
    return;
  }

  next();
}

export function createHorizonMockApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(applyChaosMiddleware);

  // Root endpoint
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      horizon_version: "2.30.0-mock",
      core_version: "19.3.0-mock",
      ingest_latest_ledger: 100000,
      history_latest_ledger: 100000,
      history_elder_ledger: 1,
      core_latest_ledger: 100000,
      network_passphrase: "Test SDF Network ; July 2015",
      current_protocol_version: 19,
      supported_protocol_version: 19,
      core_supported_protocol_version: 19,
    });
  });

  // Health endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "healthy", mode: activeChaos.outageMode });
  });

  // Accounts endpoint
  app.get("/accounts/:accountId", (req: Request, res: Response) => {
    const { accountId } = req.params;

    if (customAccounts.has(accountId)) {
      const acct = customAccounts.get(accountId)!;
      return res.json({
        id: acct.accountId,
        account_id: acct.accountId,
        sequence: acct.sequence,
        subentry_count: acct.subentryCount || 0,
        inflation_destination: acct.inflationDestination || "",
        thresholds: acct.thresholds || { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: acct.flags || { auth_required: false, auth_revocable: false, auth_immutable: false },
        balances: acct.balances,
        signers: acct.signers || [{ weight: 1, key: acct.accountId, type: "ed25519_public_key" }],
      });
    }

    // Default mock response for any account ID
    return res.json({
      id: accountId,
      account_id: accountId,
      sequence: "123456789",
      subentry_count: 1,
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
      balances: [
        { asset_type: "native", balance: "10000.0000000" },
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          balance: "500.0000000",
          limit: "922337203685.4775807",
        },
      ],
      signers: [{ weight: 1, key: accountId, type: "ed25519_public_key" }],
    });
  });

  // Account transactions stream / list
  app.get(
    ["/accounts/:accountId/transactions", "/accounts/:accountId/operations"],
    (req: Request, res: Response) => {
      const { accountId } = req.params;
      res.json({
        _links: {
          self: { href: `/accounts/${accountId}/transactions` },
          next: { href: `/accounts/${accountId}/transactions?cursor=1` },
          prev: { href: `/accounts/${accountId}/transactions?cursor=0` },
        },
        _embedded: {
          records: [
            {
              id: "tx-mock-1",
              paging_token: "1",
              successful: true,
              hash: "d2d1490212cf19bebc64f20dfd9ae067160352ef2e554d19339e7ae70f205c6d",
              ledger: 100000,
              created_at: new Date().toISOString(),
              source_account: accountId,
              source_account_sequence: "123456789",
              fee_charged: "100",
              max_fee: "1000",
              operation_count: 1,
              memo_type: "none",
            },
          ],
        },
      });
    },
  );

  // General transactions query
  app.get("/transactions", (_req: Request, res: Response) => {
    res.json({
      _embedded: {
        records: [],
      },
    });
  });

  // Single transaction lookup
  app.get("/transactions/:hash", (req: Request, res: Response) => {
    const { hash } = req.params;
    res.json({
      id: hash,
      paging_token: "1",
      successful: true,
      hash,
      ledger: 100000,
      created_at: new Date().toISOString(),
      source_account: "GACCOUNTMOCK1234567890",
      fee_charged: "100",
      max_fee: "1000",
      operation_count: 1,
    });
  });

  // Submit transaction
  app.post("/transactions", (req: Request, res: Response) => {
    const tx = req.body?.tx || req.query?.tx;
    const forceFail = req.headers["x-mock-tx-fail"] === "true";

    if (forceFail) {
      return res.status(400).json({
        type: "https://stellar.org/horizon-errors/transaction_failed",
        title: "Transaction Failed",
        status: 400,
        detail: "The transaction failed when submitted to the network.",
        extras: {
          envelope_xdr: tx || "mock_xdr",
          result_xdr: "mock_result_xdr",
          result_codes: {
            transaction: "tx_failed",
            operations: ["op_bad_auth"],
          },
        },
      });
    }

    return res.json({
      hash: "e578c772c6cf8e81561f71a0678b6638841029c7827bd3c59bd0281c9ff5d66c",
      ledger: 100001,
      envelope_xdr: tx || "mock_envelope_xdr",
      result_xdr: "mock_result_xdr",
      result_meta_xdr: "mock_result_meta_xdr",
      successful: true,
    });
  });

  // Fee stats endpoint
  app.get("/fee_stats", (_req: Request, res: Response) => {
    res.json({
      last_ledger: "100000",
      last_ledger_base_fee: "100",
      ledger_capacity_usage: "0.05",
      fee_charged: {
        max: "1000",
        min: "100",
        mode: "100",
        p10: "100",
        p50: "100",
        p90: "100",
        p99: "500",
      },
      max_fee: {
        max: "10000",
        min: "100",
        mode: "100",
        p10: "100",
        p50: "100",
        p90: "1000",
        p99: "5000",
      },
    });
  });

  // Path finding endpoints
  app.get(["/paths/strict-receive", "/paths/strict-send"], (_req: Request, res: Response) => {
    res.json({
      _embedded: {
        records: [
          {
            source_asset_type: "credit_alphanum4",
            source_asset_code: "XAF",
            source_asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            source_amount: "500.0000000",
            destination_asset_type: "credit_alphanum4",
            destination_asset_code: "USDC",
            destination_asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            destination_amount: "5.0000000",
            path: [],
          },
        ],
      },
    });
  });

  // Ledgers endpoint
  app.get("/ledgers", (_req: Request, res: Response) => {
    res.json({
      _embedded: {
        records: [
          {
            id: "ledger-100000",
            sequence: 100000,
            successful_transaction_count: 10,
            failed_transaction_count: 0,
            operation_count: 12,
            closed_at: new Date().toISOString(),
          },
        ],
      },
    });
  });

  return app;
}

export function startHorizonMockServer(port = 0): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const app = createHorizonMockApp();
    const server = app.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        return reject(new Error("Failed to get server address"));
      }
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({ server, url });
    });
    server.on("error", reject);
  });
}

export function stopHorizonMockServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}
