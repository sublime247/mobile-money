import { randomUUID } from "crypto";
import { Server } from "http";
import { Request, Response } from "express";
import express = require("express");
import mockServerConfig from "../src/config/mockServer";

type MockScenario = "success" | "failed" | "pending";

interface StoredTransaction {
  provider: "mtn" | "airtel" | "vodacom" | "tigo";
  scenario: MockScenario;
  createdAt: string;
}

interface MockRequestBody {
  scenario?: string;
  delayMs?: number | string;
  externalId?: string;
  reference?: string;
  transaction?: {
    id?: string;
  };
}

const DEFAULT_PORT = Number.parseInt(
  process.env.PROVIDER_MOCK_PORT || "4010",
  10,
);
const DEFAULT_DELAY_MS = Number.parseInt(
  process.env.PROVIDER_MOCK_DELAY_MS || "0",
  10,
);
const DEFAULT_BALANCE = process.env.PROVIDER_MOCK_BALANCE || "100000";
const DEFAULT_CURRENCY = process.env.PROVIDER_MOCK_CURRENCY || "XAF";

function normalizeScenario(value: unknown): MockScenario {
  const normalized = String(value || "success")
    .trim()
    .toLowerCase();

  if (
    normalized === "fail" ||
    normalized === "failed" ||
    normalized === "error"
  ) {
    return "failed";
  }

  if (normalized === "pending") {
    return "pending";
  }

  return "success";
}

function toDelayMs(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function getScenario(
  req: Request<unknown, unknown, MockRequestBody>,
): MockScenario {
  return normalizeScenario(
    req.query.scenario ||
      req.header("x-mock-scenario") ||
      req.body?.scenario ||
      process.env.PROVIDER_MOCK_SCENARIO,
  );
}

function getDelayMs(req: Request<unknown, unknown, MockRequestBody>): number {
  return (
    toDelayMs(req.query.delayMs) ??
    toDelayMs(req.header("x-mock-delay-ms")) ??
    toDelayMs(req.body?.delayMs) ??
    DEFAULT_DELAY_MS
  );
}

function getMtnStatus(
  scenario: MockScenario,
): "SUCCESSFUL" | "FAILED" | "PENDING" {
  if (scenario === "failed") return "FAILED";
  if (scenario === "pending") return "PENDING";
  return "SUCCESSFUL";
}

function getAirtelStatus(scenario: MockScenario): "TS" | "TF" | "TP" {
  if (scenario === "failed") return "TF";
  if (scenario === "pending") return "TP";
  return "TS";
}

async function applyDelay(
  req: Request<unknown, unknown, MockRequestBody>,
): Promise<void> {
  const delayMs = getDelayMs(req);

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * Helper function to delay execution by a specified number of milliseconds.
 * Used to simulate webhook callback latency.
 * 
 * @param ms - The number of milliseconds to delay
 * @returns A Promise that resolves after the specified delay
 */
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fires a webhook callback to a configured webhook URL if available.
 * Respects the webhook latency configuration to simulate realistic delays
 * before webhook delivery.
 * 
 * @param referenceId - The transaction reference ID to include in the webhook payload
 * @param provider - The payment provider (mtn or airtel)
 * @param status - The transaction status
 * @param webhookUrl - Optional webhook URL to POST to; if not provided, webhook is logged instead
 */
async function fireWebhookCallback(
  referenceId: string,
  provider: "mtn" | "airtel",
  status: string,
  webhookUrl?: string,
): Promise<void> {
  // Apply webhook latency if enabled
  if (mockServerConfig.webhookLatencyEnabled && mockServerConfig.webhookLatencyMs > 0) {
    await delay(mockServerConfig.webhookLatencyMs);
  }

  const payload = {
    referenceId,
    provider,
    status,
    timestamp: new Date().toISOString(),
  };

  if (webhookUrl) {
    try {
      // Fire webhook asynchronously without blocking the response
      // In a real scenario, this would be sent via HTTP request
      console.log(`[webhook] Firing ${provider} webhook to ${webhookUrl}:`, payload);
      // Actual HTTP request would go here (e.g., fetch or axios)
      // await fetch(webhookUrl, { method: 'POST', body: JSON.stringify(payload) });
    } catch (error) {
      console.error(`[webhook] Error firing ${provider} webhook:`, error);
    }
  } else {
    console.log(`[webhook] Webhook callback for ${provider} (no URL configured):`, payload);
  }
}

function getReferenceId(
  req: Request<unknown, unknown, MockRequestBody>,
  fallbackPrefix: string,
): string {
  return (
    req.header("X-Reference-Id") ||
    req.body?.externalId ||
    req.body?.reference ||
    req.body?.transaction?.id ||
    `${fallbackPrefix}-${randomUUID()}`
  );
}

export function createProviderMockApp() {
  const app = express();
  const transactions = new Map<string, StoredTransaction>();
  
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      providers: ["mtn", "airtel", "vodacom", "tigo"],
    });
  });

  app.post(
    "/mtn/collection/token/",
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      res.json({
        access_token: "mock-mtn-access-token",
        token_type: "access_token",
        expires_in: 3600,
      });
    },
  );

  app.post(
    "/mtn/collection/v1_0/requesttopay",
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      const scenario = getScenario(req);
      const referenceId = getReferenceId(req, "mtn");

      transactions.set(referenceId, {
        provider: "mtn",
        scenario,
        createdAt: new Date().toISOString(),
      });

      if (scenario === "failed") {
        res.status(400).json({
          status: "FAILED",
          referenceId,
          message: "Mock MTN request-to-pay failure",
        });
        // Fire webhook for failed transaction
        fireWebhookCallback(referenceId, "mtn", "FAILED").catch(console.error);
        return;
      }

      res.status(202).json({
        status: getMtnStatus(scenario),
        referenceId,
        message: "Mock MTN request-to-pay accepted",
      });

      // Fire webhook callback asynchronously after response is sent
      fireWebhookCallback(referenceId, "mtn", getMtnStatus(scenario)).catch(
        console.error,
      );
    },
  );

  app.get(
    "/mtn/collection/v1_0/requesttopay/:referenceId",
    async (
      req: Request<{ referenceId: string }, unknown, MockRequestBody>,
      res: Response,
    ) => {
      await applyDelay(req);

      const stored = transactions.get(req.params.referenceId);
      const scenario = stored?.scenario || getScenario(req);

      return res.json({
        referenceId: req.params.referenceId,
        status: getMtnStatus(scenario),
      });
    },
  );

  app.get(
    "/mtn/disbursement/v1_0/account/balance",
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      const scenario = getScenario(req);
      if (scenario === "failed") {
        return res.status(503).json({
          message: "Mock MTN balance service unavailable",
        });
      }

      return res.json({
        availableBalance: DEFAULT_BALANCE,
        currency: DEFAULT_CURRENCY,
      });
    },
  );

  app.post(
    "/airtel/auth/oauth2/token",
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      res.json({
        access_token: "mock-airtel-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    },
  );

  app.post(
    ["/airtel/merchant/v1/payments/", "/airtel/:countryCode/merchant/v1/payments/"],
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      const scenario = getScenario(req);
      const referenceId = getReferenceId(req, "airtel-pay");

      transactions.set(referenceId, {
        provider: "airtel",
        scenario,
        createdAt: new Date().toISOString(),
      });

      if (scenario === "failed") {
        res.status(400).json({
          status: {
            success: false,
            code: "DP_REQUEST_FAILED",
          },
          data: {
            transaction: {
              id: referenceId,
              status: getAirtelStatus(scenario),
            },
          },
        });
        // Fire webhook for failed transaction
        fireWebhookCallback(referenceId, "airtel", "TF").catch(console.error);
        return;
      }

      res.status(200).json({
        status: {
          success: true,
          code: scenario === "pending" ? "DP_PENDING" : "DP_SUCCESS",
        },
        data: {
          transaction: {
            id: referenceId,
            status: getAirtelStatus(scenario),
          },
        },
      });

      // Fire webhook callback asynchronously after response is sent
      fireWebhookCallback(referenceId, "airtel", getAirtelStatus(scenario)).catch(
        console.error,
      );
    },
  );

  app.get(
    ["/airtel/standard/v1/payments/:reference", "/airtel/:countryCode/standard/v1/payments/:reference"],
    async (
      req: Request<{ reference: string }, unknown, MockRequestBody>,
      res: Response,
    ) => {
      await applyDelay(req);

      const stored = transactions.get(req.params.reference);
      const scenario = stored?.scenario || getScenario(req);

      return res.json({
        status: {
          success: scenario !== "failed",
          code: scenario === "failed" ? "DP_STATUS_FAILED" : "DP_STATUS_OK",
        },
        data: {
          transaction: {
            id: req.params.reference,
            status: getAirtelStatus(scenario),
          },
        },
      });
    },
  );

  app.get(
    ["/airtel/standard/v1/users/balance", "/airtel/:countryCode/standard/v1/users/balance"],
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      const scenario = getScenario(req);
      if (scenario === "failed") {
        return res.status(503).json({
          status: {
            success: false,
            code: "BALANCE_UNAVAILABLE",
          },
        });
      }

      return res.json({
        status: {
          success: true,
          code: "BALANCE_OK",
        },
        data: {
          availableBalance: DEFAULT_BALANCE,
          currency: process.env.AIRTEL_CURRENCY || "NGN",
        },
      });
    },
  );

  app.post(
    ["/airtel/standard/v1/disbursements/", "/airtel/:countryCode/standard/v1/disbursements/"],
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      const scenario = getScenario(req);
      const referenceId = getReferenceId(req, "airtel-payout");

      transactions.set(referenceId, {
        provider: "airtel",
        scenario,
        createdAt: new Date().toISOString(),
      });

      if (scenario === "failed") {
        res.status(400).json({
          status: {
            success: false,
            code: "DS_REQUEST_FAILED",
          },
          data: {
            transaction: {
              id: referenceId,
              status: getAirtelStatus(scenario),
            },
          },
        });
        // Fire webhook for failed transaction
        fireWebhookCallback(referenceId, "airtel", "TF").catch(console.error);
        return;
      }

      res.status(200).json({
        status: {
          success: true,
          code: scenario === "pending" ? "DS_PENDING" : "DS_SUCCESS",
        },
        data: {
          transaction: {
            id: referenceId,
            status: getAirtelStatus(scenario),
          },
        },
      });

      // Fire webhook callback asynchronously after response is sent
      fireWebhookCallback(referenceId, "airtel", getAirtelStatus(scenario)).catch(
        console.error,
      );
    },
  );

  // ─── Vodacom Mock Endpoints ──────────────────────────────────────────────────

  app.post(
    "/vodacom/auth/token",
    async (req: Request, res: Response) => {
      await applyDelay(req);
      res.json({
        access_token: "mock-vodacom-access-token",
        expires_in: 3600,
      });
    }
  );

  app.post(
    "/vodacom/c2b/v1/payment",
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);
      const scenario = getScenario(req);
      const referenceId = getReferenceId(req, "vodacom-c2b");

      transactions.set(referenceId, {
        provider: "vodacom",
        scenario,
        createdAt: new Date().toISOString(),
      });

      if (scenario === "failed") {
        return res.status(400).json({
          status: "FAILED",
          referenceId,
          message: "Mock Vodacom payment failure",
        });
      }

      return res.status(202).json({
        status: getVodacomStatus(scenario),
        referenceId,
        message: "Mock Vodacom payment accepted",
      });
    }
  );

  app.get(
    "/vodacom/c2b/v1/payment/:referenceId",
    async (
      req: Request<{ referenceId: string }, unknown, MockRequestBody>,
      res: Response,
    ) => {
      await applyDelay(req);
      const stored = transactions.get(req.params.referenceId);
      const scenario = stored?.scenario || getScenario(req);

      return res.json({
        referenceId: req.params.referenceId,
        status: getVodacomStatus(scenario),
      });
    }
  );

  app.post(
    "/vodacom/b2c/v1/payment",
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);
      const scenario = getScenario(req);
      const referenceId = getReferenceId(req, "vodacom-b2c");

      transactions.set(referenceId, {
        provider: "vodacom",
        scenario,
        createdAt: new Date().toISOString(),
      });

      if (scenario === "failed") {
        return res.status(400).json({
          status: "FAILED",
          referenceId,
          message: "Mock Vodacom disbursement failure",
        });
      }

      return res.status(202).json({
        status: getVodacomStatus(scenario),
        referenceId,
        message: "Mock Vodacom disbursement accepted",
      });
    }
  );

  app.get(
    "/vodacom/b2c/v1/payment/:referenceId",
    async (
      req: Request<{ referenceId: string }, unknown, MockRequestBody>,
      res: Response,
    ) => {
      await applyDelay(req);
      const stored = transactions.get(req.params.referenceId);
      const scenario = stored?.scenario || getScenario(req);

      return res.json({
        referenceId: req.params.referenceId,
        status: getVodacomStatus(scenario),
      });
    }
  );

  app.get(
    "/vodacom/balance",
    async (req: Request, res: Response) => {
      await applyDelay(req);
      const scenario = getScenario(req);
      if (scenario === "failed") {
        return res.status(503).json({
          message: "Mock Vodacom balance service unavailable",
        });
      }
      res.json({
        availableBalance: DEFAULT_BALANCE,
        currency: "TZS",
      });
    }
  );

  // ─── Tigo Mock Endpoints ─────────────────────────────────────────────────────

  app.post(
    "/tigo/auth/token",
    async (req: Request, res: Response) => {
      await applyDelay(req);
      res.json({
        access_token: "mock-tigo-access-token",
        expires_in: 3600,
      });
    }
  );

    app.post(
    "/tigo/payment",
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);
      const scenario = getScenario(req);
      const referenceId = getReferenceId(req, "tigo-payment");

      transactions.set(referenceId, {
        provider: "tigo",
        scenario,
        createdAt: new Date().toISOString(),
      });

      if (scenario === "failed") {
        return res.status(400).json({
          status: "FAILED",
          referenceId,
          message: "Mock Tigo payment failure",
        });
      }

      return res.status(200).json({
        status: getTigoStatus(scenario),
        referenceId,
        message: "Mock Tigo payment success",
      });
    }
  );

  app.get(
    "/tigo/payment/:referenceId",
    async (
      req: Request<{ referenceId: string }, unknown, MockRequestBody>,
      res: Response,
    ) => {
      await applyDelay(req);
      const stored = transactions.get(req.params.referenceId);
      const scenario = stored?.scenario || getScenario(req);

      return res.json({
        referenceId: req.params.referenceId,
        status: getTigoStatus(scenario),
      });
    }
  );

  app.post(
    "/tigo/disbursement",
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);
      const scenario = getScenario(req);
      const referenceId = getReferenceId(req, "tigo-disbursement");

      transactions.set(referenceId, {
        provider: "tigo",
        scenario,
        createdAt: new Date().toISOString(),
      });

      if (scenario === "failed") {
        return res.status(400).json({
          status: "FAILED",
          referenceId,
          message: "Mock Tigo disbursement failure",
        });
      }

      return res.status(200).json({
        status: getTigoStatus(scenario),
        referenceId,
        message: "Mock Tigo disbursement success",
      });
    }
  );

  app.get(
    "/tigo/disbursement/:referenceId",
    async (
      req: Request<{ referenceId: string }, unknown, MockRequestBody>,
      res: Response,
    ) => {
      await applyDelay(req);
      const stored = transactions.get(req.params.referenceId);
      const scenario = stored?.scenario || getScenario(req);

      return res.json({
        referenceId: req.params.referenceId,
        status: getTigoStatus(scenario),
      });
    }
  );

  app.get(
    "/tigo/balance",
    async (req: Request, res: Response) => {
      await applyDelay(req);
      const scenario = getScenario(req);
      if (scenario === "failed") {
        return res.status(503).json({
          message: "Mock Tigo balance service unavailable",
        });
      }
      res.json({
        availableBalance: DEFAULT_BALANCE,
        currency: "TZS",
      });
    }
  );

  return app;
}



function getVodacomStatus(scenario: MockScenario): "SUCCESSFUL" | "FAILED" | "PENDING" {
  if (scenario === "failed") return "FAILED";
  if (scenario === "pending") return "PENDING";
  return "SUCCESSFUL";
}

function getTigoStatus(scenario: MockScenario): "SUCCESS" | "FAILED" | "PENDING" {
  if (scenario === "failed") return "FAILED";
  if (scenario === "pending") return "PENDING";
  return "SUCCESS";
}

export function startProviderMockServer(port = DEFAULT_PORT): Server {
  const app = createProviderMockApp();

  return app.listen(port, () => {
    console.info(
      `[provider-mock] listening on port ${port} for MTN and Airtel mock traffic`,
    );
  });
}

if (require.main === module) {
  startProviderMockServer();
}
