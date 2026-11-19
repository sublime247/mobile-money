import express from "express";
import request from "supertest";
import { createHmac } from "crypto";
import axios from "axios";
import { MTNProvider } from "../../services/mobilemoney/providers/mtn";
import { reconcilePendingTransactions } from "../../services/providers/mtnMomo";
import mtnCallbacksRouter from "../../routes/mtnCallbacks";
import { errorHandler } from "../../middleware/errorHandler";
import { queryRead, queryWrite } from "../../config/database";
import { TransactionStatus } from "../../models/transaction";
import { getConfigValue } from "../../config/appConfig";

jest.mock("axios");
jest.mock("../../config/database");
jest.mock("../../config/appConfig", () => ({
  getConfigValue: jest.fn((key: string) => {
    if (key === "providers.mtn.callbackSecret") return "test-mtn-secret";
    if (key === "providers.mtn.callbackSignatureHeader")
      return "x-callback-signature";
    return undefined;
  }),
}));

const axiosMock = axios as jest.Mocked<typeof axios>;
const mockQueryRead = queryRead as jest.MockedFunction<typeof queryRead>;
const mockQueryWrite = queryWrite as jest.MockedFunction<typeof queryWrite>;

function buildSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("MTN Payout Confirmation Routines (Integration Tests)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetAllMocks();
    (getConfigValue as jest.Mock).mockImplementation((key: string) => {
      if (key === "providers.mtn.callbackSecret") return "test-mtn-secret";
      if (key === "providers.mtn.callbackSignatureHeader")
        return "x-callback-signature";
      return undefined;
    });

    process.env = {
      ...originalEnv,
      MTN_API_KEY: "test-api-key",
      MTN_API_SECRET: "test-api-secret",
      MTN_SUBSCRIPTION_KEY: "test-subscription-key",
      MTN_TARGET_ENVIRONMENT: "sandbox",
      MTN_BASE_URL: "https://sandbox.momodeveloper.mtn.com",
    };

    // Default mock for token generation
    axiosMock.post.mockImplementation(async (url: any) => {
      if (String(url).includes("/collection/token/")) {
        return {
          status: 200,
          data: { access_token: "mock-mtn-token-123", expires_in: 3600 },
        } as any;
      }
      throw new Error(`Unhandled axios.post to: ${String(url)}`);
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("1. Direct and Polled Status Confirmation Routines", () => {
    it("confirms payout when MTN transaction status returns SUCCESSFUL", async () => {
      const provider = new MTNProvider();

      axiosMock.get.mockImplementation(async (url: any) => {
        if (String(url).includes("/requesttopay/")) {
          return {
            status: 200,
            data: {
              status: "SUCCESSFUL",
              financialTransactionId: "mtn-fin-1001",
            },
          } as any;
        }
        throw new Error(`Unhandled axios.get to: ${String(url)}`);
      });

      const confirmation = await provider.getTransactionStatus("tx-payout-001");
      expect(confirmation.status).toBe("completed");
    });

    it("confirms payout failure when MTN transaction status returns FAILED", async () => {
      const provider = new MTNProvider();

      axiosMock.get.mockImplementation(async (url: any) => {
        if (String(url).includes("/requesttopay/")) {
          return {
            status: 200,
            data: { status: "FAILED", reason: "PAYER_NOT_FOUND" },
          } as any;
        }
        throw new Error(`Unhandled axios.get to: ${String(url)}`);
      });

      const confirmation = await provider.getTransactionStatus("tx-payout-002");
      expect(confirmation.status).toBe("failed");
    });

    it("identifies in-flight transactions when MTN returns PENDING", async () => {
      const provider = new MTNProvider();

      axiosMock.get.mockImplementation(async (url: any) => {
        if (String(url).includes("/requesttopay/")) {
          return {
            status: 200,
            data: { status: "PENDING" },
          } as any;
        }
        throw new Error(`Unhandled axios.get to: ${String(url)}`);
      });

      const confirmation = await provider.getTransactionStatus("tx-payout-003");
      expect(confirmation.status).toBe("pending");
    });

    it("handles network timeouts during status check gracefully by returning unknown/pending", async () => {
      const provider = new MTNProvider();

      axiosMock.get.mockRejectedValue(new Error("Network timeout"));

      const confirmation = await provider.getTransactionStatus("tx-payout-004");
      expect(confirmation.status).toBe("unknown");
    });
  });

  describe("2. Batch Payout Confirmation and Multi-Item Resolution", () => {
    it("confirms batch payout items with mixed terminal outcomes (success and failure)", async () => {
      const provider = new MTNProvider();

      const batchItems = [
        {
          referenceId: "payout-1",
          phoneNumber: "+237670000001",
          amount: "5000",
        },
        {
          referenceId: "payout-2",
          phoneNumber: "+237670000002",
          amount: "10000",
        },
        {
          referenceId: "payout-3",
          phoneNumber: "+237670000003",
          amount: "15000",
        },
      ];

      axiosMock.post.mockImplementation(async (url: any) => {
        if (String(url).includes("/collection/token/")) {
          return {
            status: 200,
            data: { access_token: "mock-mtn-token-123", expires_in: 3600 },
          } as any;
        }
        if (String(url).includes("/disbursement/v2_0/batch-payout")) {
          return {
            status: 202,
            data: {
              batchReference: "BATCH-TEST-001",
              items: [
                {
                  referenceId: "payout-1",
                  status: "SUCCESSFUL",
                  financialTransactionId: "fin-001",
                },
                {
                  referenceId: "payout-2",
                  status: "FAILED",
                  errorReason: "INSUFFICIENT_FUNDS",
                },
                {
                  referenceId: "payout-3",
                  status: "SUCCESS",
                  transactionId: "trx-003",
                },
              ],
            },
          } as any;
        }
        throw new Error(`Unhandled axios.post to: ${String(url)}`);
      });

      const result = await provider.sendBatchPayout(batchItems);

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(3);

      expect(result.results[0]).toEqual({
        referenceId: "payout-1",
        success: true,
        providerReference: "fin-001",
        error: undefined,
      });

      expect(result.results[1]).toEqual({
        referenceId: "payout-2",
        success: false,
        error: "INSUFFICIENT_FUNDS",
        providerReference: undefined,
      });

      expect(result.results[2]).toEqual({
        referenceId: "payout-3",
        success: true,
        providerReference: "trx-003",
        error: undefined,
      });
    });

    it("rejects batches exceeding maximum allowed size", async () => {
      const provider = new MTNProvider();
      const oversizedBatch = Array.from({ length: 55 }, (_, i) => ({
        referenceId: `tx-${i}`,
        phoneNumber: "+237670000000",
        amount: "1000",
      }));

      const result = await provider.sendBatchPayout(oversizedBatch);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.results).toHaveLength(55);
      expect(result.results[0].error).toContain("exceeds maximum of 50");
    });
  });

  describe("3. Database Payout Reconciliation Routine", () => {
    it("fetches pending MTN transactions and updates confirmed payouts to completed in database", async () => {
      const mockPendingList = [
        {
          id: "db-tx-1",
          referenceNumber: "REF-101",
          providerReference: "PROV-101",
          phoneNumber: "+237670000001",
          amount: "5000",
          status: TransactionStatus.Pending,
          createdAt: new Date(),
        },
        {
          id: "db-tx-2",
          referenceNumber: "REF-102",
          providerReference: "PROV-102",
          phoneNumber: "+237670000002",
          amount: "2500",
          status: TransactionStatus.Pending,
          createdAt: new Date(),
        },
      ];

      mockQueryRead.mockResolvedValueOnce({ rows: mockPendingList } as any);

      // MTN status API queries
      axiosMock.get
        .mockResolvedValueOnce({
          status: 200,
          data: { status: "SUCCESSFUL" },
        } as any)
        .mockResolvedValueOnce({
          status: 200,
          data: { status: "FAILED" },
        } as any);

      mockQueryWrite.mockResolvedValue({ rows: [] } as any);

      const report = await reconcilePendingTransactions();

      expect(report.total).toBe(2);
      expect(report.updated).toBe(2);
      expect(report.results[0].newStatus).toBe(TransactionStatus.Completed);
      expect(report.results[1].newStatus).toBe(TransactionStatus.Failed);

      // Verify DB update calls
      expect(mockQueryWrite).toHaveBeenCalledWith(
        expect.stringContaining(
          "UPDATE transactions SET status = $1 WHERE id = $2",
        ),
        [TransactionStatus.Completed, "db-tx-1"],
      );
      expect(mockQueryWrite).toHaveBeenCalledWith(
        expect.stringContaining(
          "UPDATE transactions SET status = $1 WHERE id = $2",
        ),
        [TransactionStatus.Failed, "db-tx-2"],
      );
    });

    it("leaves transactions in pending state when MTN reports pending or unknown", async () => {
      const mockPendingList = [
        {
          id: "db-tx-3",
          referenceNumber: "REF-103",
          providerReference: null,
          phoneNumber: "+237670000003",
          amount: "1500",
          status: TransactionStatus.Pending,
          createdAt: new Date(),
        },
      ];

      mockQueryRead.mockResolvedValueOnce({ rows: mockPendingList } as any);
      axiosMock.get.mockResolvedValueOnce({
        status: 200,
        data: { status: "PENDING" },
      } as any);

      const report = await reconcilePendingTransactions();

      expect(report.total).toBe(1);
      expect(report.updated).toBe(0);
      expect(report.results[0].updated).toBe(false);
      expect(report.results[0].newStatus).toBeNull();
      expect(mockQueryWrite).not.toHaveBeenCalled();
    });
  });

  describe("4. MTN Payout Callback Webhook Confirmation Routines", () => {
    let app: express.Application;

    beforeEach(() => {
      app = express();
      app.use(
        express.json({
          verify: (req, _res, buf) => {
            (req as any).rawBody = buf;
          },
        }),
      );
      app.use("/api/mtn", mtnCallbacksRouter);
      app.use(errorHandler);
    });

    it("verifies and acknowledges a signed confirmation callback", async () => {
      const payload = {
        transactionId: "payout-callback-101",
        status: "SUCCESSFUL",
        amount: "5000",
        currency: "XAF",
        financialTransactionId: "FT-998877",
      };

      const payloadString = JSON.stringify(payload);
      const signature = buildSignature(payloadString, "test-mtn-secret");

      const response = await request(app)
        .post("/api/mtn/callback")
        .set("X-Callback-Signature", signature)
        .set("x-trace-id", "trace-test-101")
        .send(payload)
        .expect(200);

      expect(response.body).toEqual({ status: "accepted" });
    });

    it("rejects payout confirmation callback when signature header is missing", async () => {
      const payload = {
        transactionId: "payout-callback-102",
        status: "SUCCESSFUL",
      };

      const response = await request(app)
        .post("/api/mtn/callback")
        .send(payload)
        .expect(401);

      expect(response.body.error).toBe("Unauthorized callback");
    });

    it("rejects payout confirmation callback when signature is invalid or tampered", async () => {
      const payload = {
        transactionId: "payout-callback-103",
        status: "SUCCESSFUL",
      };

      const response = await request(app)
        .post("/api/mtn/callback")
        .set("X-Callback-Signature", "invalid-tampered-signature")
        .send(payload)
        .expect(401);

      expect(response.body.error).toBe("Unauthorized callback");
    });
  });
});
