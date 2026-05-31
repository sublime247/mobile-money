import { randomUUID } from "crypto";
import { Server } from "http";
import { Request, Response } from "express";
import express = require("express");

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

function getVodacomStatus(
  scenario: MockScenario,
): "SUCCESSFUL" | "FAILED" | "PENDING" {
  if (scenario === "failed") return "FAILED";
  if (scenario === "pending") return "PENDING";
  return "SUCCESSFUL";
}

function getTigoStatus(
  scenario: MockScenario,
): "SUCCESSFUL" | "FAILED" | "PENDING" {
  if (scenario === "failed") return "FAILED";
  if (scenario === "pending") return "PENDING";
  return "SUCCESSFUL";
}

async function applyDelay(
  req: Request<unknown, unknown, MockRequestBody>,
): Promise<void> {
  const delayMs = getDelayMs(req);

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
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
        return res.status(400).json({
          status: "FAILED",
          referenceId,
          message: "Mock MTN request-to-pay failure",
        });
      }

      return res.status(202).json({
        status: getMtnStatus(scenario),
        referenceId,
        message: "Mock MTN request-to-pay accepted",
      });
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
    "/airtel/merchant/v1/payments/",
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
        return res.status(400).json({
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
      }

      return res.status(200).json({
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
    },
  );

  app.get(
    "/airtel/standard/v1/payments/:reference",
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
    "/airtel/standard/v1/users/balance",
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
    "/airtel/standard/v1/disbursements/",
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
        return res.status(400).json({
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
      }

      return res.status(200).json({
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
    },
  );

  // ──────────────────────────────────────────────────────────────
  // VODACOM M-PESA MOCK ENDPOINTS
  // ──────────────────────────────────────────────────────────────

  const VODACOM_MARKET = process.env.VODACOM_MARKET || "vodacomTZN";

  app.get(
    `/${VODACOM_MARKET}/getSession/`,
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      const scenario = getScenario(req);
      if (scenario === "failed") {
        return res.status(401).json({
          output_ResponseCode: "INS-4",
          output_ResponseDesc: "Mock Vodacom session authorization failed",
        });
      }

      return res.json({
        output_SessionID: `mock-vodacom-session-${randomUUID()}`,
        output_ResponseCode: "INS-0",
        output_ResponseDesc: "Service request accepted successfully",
      });
    },
  );

  app.post(
    `/${VODACOM_MARKET}/c2bPayment/singleStage/`,
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      const scenario = getScenario(req);
      const referenceId = getReferenceId(req, "voda-c2b");

      transactions.set(referenceId, {
        provider: "vodacom",
        scenario,
        createdAt: new Date().toISOString(),
      });

      if (scenario === "failed") {
        return res.status(400).json({
          output_ResponseCode: "INS-1",
          output_ResponseDesc: "Mock Vodacom C2B payment failure",
          output_TransactionID: referenceId,
        });
      }

      return res.status(200).json({
        output_ResponseCode: "INS-0",
        output_ResponseDesc: "Service request accepted successfully",
        output_TransactionID: referenceId,
        output_ConversationID: `VODA-CONV-${randomUUID()}`,
      });
    },
  );

  app.post(
    `/${VODACOM_MARKET}/b2cPayment/singleStage/`,
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      const scenario = getScenario(req);
      const referenceId = getReferenceId(req, "voda-b2c");

      transactions.set(referenceId, {
        provider: "vodacom",
        scenario,
        createdAt: new Date().toISOString(),
      });

      if (scenario === "failed") {
        return res.status(400).json({
          output_ResponseCode: "INS-1",
          output_ResponseDesc: "Mock Vodacom B2C payout failure",
          output_TransactionID: referenceId,
        });
      }

      return res.status(200).json({
        output_ResponseCode: "INS-0",
        output_ResponseDesc: "Service request accepted successfully",
        output_TransactionID: referenceId,
        output_ConversationID: `VODA-CONV-${randomUUID()}`,
      });
    },
  );

  app.get(
    `/${VODACOM_MARKET}/queryTransactionStatus/`,
    async (
      req: Request<unknown, unknown, MockRequestBody>,
      res: Response,
    ) => {
      await applyDelay(req);

      const queryRef = String(req.query.input_QueryReference || "");
      const stored = transactions.get(queryRef);
      const scenario = stored?.scenario || getScenario(req);

      return res.json({
        output_ResponseCode: "INS-0",
        output_ResponseDesc: "Service request accepted successfully",
        output_TransactionStatus: getVodacomStatus(scenario),
      });
    },
  );

  // ──────────────────────────────────────────────────────────────
  // TIGO MOCK ENDPOINTS
  // ──────────────────────────────────────────────────────────────

  app.post(
    "/tigo/oauth/token",
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      const scenario = getScenario(req);
      if (scenario === "failed") {
        return res.status(401).json({
          error: "invalid_client",
          error_description: "Mock Tigo authentication failed",
        });
      }

      return res.json({
        access_token: `mock-tigo-access-token-${randomUUID()}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    },
  );

  app.post(
    "/tigo/payments/collect",
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      const scenario = getScenario(req);
      const referenceId =
        req.body?.externalId || getReferenceId(req, "tigo-collect");

      transactions.set(referenceId, {
        provider: "tigo",
        scenario,
        createdAt: new Date().toISOString(),
      });

      if (scenario === "failed") {
        return res.status(400).json({
          status: "FAILED",
          referenceId,
          message: "Mock Tigo collect payment failure",
        });
      }

      return res.status(202).json({
        status: getTigoStatus(scenario),
        referenceId,
        financialTransactionId: `TIGO-TX-${randomUUID()}`,
        message: "Mock Tigo collect payment accepted",
      });
    },
  );

  app.post(
    "/tigo/payments/disburse",
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      const scenario = getScenario(req);
      const referenceId =
        req.body?.externalId || getReferenceId(req, "tigo-disburse");

      transactions.set(referenceId, {
        provider: "tigo",
        scenario,
        createdAt: new Date().toISOString(),
      });

      if (scenario === "failed") {
        return res.status(400).json({
          status: "FAILED",
          referenceId,
          message: "Mock Tigo disburse payout failure",
        });
      }

      return res.status(202).json({
        status: getTigoStatus(scenario),
        referenceId,
        financialTransactionId: `TIGO-TX-${randomUUID()}`,
        message: "Mock Tigo disburse payout accepted",
      });
    },
  );

  app.get(
    "/tigo/payments/status/:referenceId",
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
        financialTransactionId: `TIGO-TX-${randomUUID()}`,
      });
    },
  );

  app.get(
    "/tigo/account/balance",
    async (req: Request<unknown, unknown, MockRequestBody>, res: Response) => {
      await applyDelay(req);

      const scenario = getScenario(req);
      if (scenario === "failed") {
        return res.status(503).json({
          error: "SERVICE_UNAVAILABLE",
          message: "Mock Tigo balance service unavailable",
        });
      }

      return res.json({
        availableBalance: DEFAULT_BALANCE,
        currency: "XAF",
      });
    },
  );

  return app;
}

export function startProviderMockServer(port = DEFAULT_PORT): Server {
  const app = createProviderMockApp();

  return app.listen(port, () => {
    console.info(
      `[provider-mock] listening on port ${port} for MTN, Airtel, Vodacom, and Tigo mock traffic`,
    );
  });
}

if (require.main === module) {
  startProviderMockServer();
}
