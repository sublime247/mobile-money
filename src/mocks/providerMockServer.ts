import express from "express";
import { Server } from "http";

type MockScenario = "success" | "failed" | "pending" | "timeout" | "crash" | "slow";

interface ChaosControl {
  shouldTimeout: boolean;
  shouldCrash: boolean;
  shouldDelay: boolean;
  delayMs: number;
  errorRate: number;
}

const DEFAULT_CHAOS: ChaosControl = {
  shouldTimeout: false,
  shouldCrash: false,
  shouldDelay: false,
  delayMs: 0,
  errorRate: 0,
};

let activeChaos: ChaosControl = { ...DEFAULT_CHAOS };

export function setChaosControl(control: Partial<ChaosControl>): void {
  activeChaos = { ...DEFAULT_CHAOS, ...control };
}

export function resetChaosControl(): void {
  activeChaos = { ...DEFAULT_CHAOS };
}

export function getChaosControl(): ChaosControl {
  return { ...activeChaos };
}

interface StoredTransaction {
  provider: string;
  scenario: MockScenario;
  createdAt: string;
}

function normalizeScenario(value: unknown): MockScenario {
  const s = String(value || "success").trim().toLowerCase();
  if (s === "fail" || s === "failed" || s === "error") return "failed";
  if (s === "pending") return "pending";
  if (s === "timeout") return "timeout";
  if (s === "crash") return "crash";
  if (s === "slow") return "slow";
  return "success";
}

function getScenario(req: express.Request): MockScenario {
  return normalizeScenario(
    req.query.scenario || req.header("x-mock-scenario") || "success",
  );
}

function getMtnStatus(scenario: MockScenario): "SUCCESSFUL" | "FAILED" | "PENDING" {
  if (scenario === "failed" || scenario === "crash") return "FAILED";
  if (scenario === "pending") return "PENDING";
  return "SUCCESSFUL";
}

function getAirtelStatus(scenario: MockScenario): "TS" | "TF" | "TP" {
  if (scenario === "failed" || scenario === "crash") return "TF";
  if (scenario === "pending") return "TP";
  return "TS";
}

function getOrangeStatus(scenario: MockScenario): "SUCCESSFUL" | "FAILED" | "PENDING" | "IN_PROGRESS" {
  if (scenario === "failed" || scenario === "crash") return "FAILED";
  if (scenario === "pending") return "PENDING";
  return "SUCCESSFUL";
}

function shouldInjectError(): boolean {
  if (activeChaos.errorRate > 0 && Math.random() < activeChaos.errorRate) return true;
  return false;
}

async function applyChaos(req: express.Request): Promise<void> {
  const delayFromQuery = parseInt(String(req.query.delayMs || "0"), 10);
  const totalDelay = delayFromQuery > 0 ? delayFromQuery : activeChaos.delayMs;

  if (activeChaos.shouldTimeout) {
    await new Promise(() => {});
  }

  if (activeChaos.shouldCrash) {
    throw new Error("Simulated server crash");
  }

  if (totalDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, totalDelay));
  }

  if (activeChaos.shouldDelay && activeChaos.delayMs > 30000) {
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }

  if (shouldInjectError()) {
    throw new Error("Simulated random API error");
  }
}

function getReferenceId(req: express.Request, prefix: string): string {
  return (
    req.header("X-Reference-Id") ||
    req.body?.externalId ||
    req.body?.reference ||
    req.body?.transaction?.id ||
    `${prefix}-${Date.now()}`
  );
}

export function createMockServerApp(): express.Application {
  const app = express();
  const transactions = new Map<string, StoredTransaction>();

  app.use(express.json());

  app.get("/health", (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok", providers: ["mtn", "airtel", "vodacom", "tigo", "orange"] });
  });

  app.post("/mock/orange/callback", async (req: express.Request, res: express.Response) => {
    try {
      await applyChaos(req);
      const scenario = getScenario(req);
      const reference = req.body?.reference || req.body?.referenceId || "orange-ref-001";
      const status = getOrangeStatus(scenario);

      if (scenario === "failed" || scenario === "crash") {
        res.status(400).json({
          status: "FAILED",
          reference,
          failureReason: req.body?.failureReason || "Simulated Orange callback failure",
        });
        return;
      }

      res.status(200).json({
        status: "accepted",
        reference,
        transactionStatus: status,
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(500).json({ error: "Simulated chaos error" });
    }
  });

  app.post("/mtn/collection/token/", async (req: express.Request, res: express.Response) => {
    try {
      await applyChaos(req);
      res.json({
        access_token: "mock-mtn-access-token",
        token_type: "access_token",
        expires_in: 3600,
      });
    } catch {
      res.status(500).json({ error: "Simulated chaos error" });
    }
  });

  app.post("/mtn/collection/v1_0/requesttopay", async (req: express.Request, res: express.Response) => {
    try {
      await applyChaos(req);
      const scenario = getScenario(req);
      const referenceId = getReferenceId(req, "mtn");

      transactions.set(referenceId, {
        provider: "mtn",
        scenario,
        createdAt: new Date().toISOString(),
      });

      if (scenario === "failed" || scenario === "crash") {
        res.status(400).json({ status: "FAILED", referenceId, message: "Chaos mock failure" });
        return;
      }

      res.status(202).json({ status: getMtnStatus(scenario), referenceId });
    } catch {
      res.status(500).json({ error: "Simulated chaos error" });
    }
  });

  app.get("/mtn/collection/v1_0/requesttopay/:referenceId", async (req: express.Request, res: express.Response) => {
    try {
      await applyChaos(req);
      const referenceId = req.params.referenceId;
      const stored = transactions.get(referenceId);
      const scenario = stored ? stored.scenario : getScenario(req);

      res.json({
        referenceId,
        status: getMtnStatus(scenario),
        financialTransactionId: "mock-fin-id-123",
      });
    } catch {
      res.status(500).json({ error: "Simulated chaos error" });
    }
  });

  return app;
}
