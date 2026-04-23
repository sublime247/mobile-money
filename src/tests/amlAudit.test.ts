import { pool } from "../config/database";
import { generateToken } from "../auth/jwt";
import { AMLAlertModel } from "../models/amlAlert";
import { TransactionModel } from "../models/transaction";
import { UserModel } from "../models/users";
import {
  listAmlAlertsForAudit,
  getAmlAlertDetails,
  reviewAmlAlert,
  searchAmlAlertsByUser,
  getAmlDashboardStats,
} from "../controllers/amlAuditController";
import { Request, Response } from "express";

describe("AML Audit Dashboard", () => {
  let testUserId: string;
  let testTransactionId: string;
  let testAlertId: string;

  const amlAlertModel = new AMLAlertModel();
  const transactionModel = new TransactionModel();
  const userModel = new UserModel();

  beforeAll(async () => {
    // Create test user
    const user = await pool.query(
      `INSERT INTO users (phone_number, kyc_level) 
       VALUES ($1, $2) 
       RETURNING id`,
      ["+237600000001", "basic"]
    );
    testUserId = user.rows[0].id;

    // Create test transaction
    const transaction = await pool.query(
      `INSERT INTO transactions (type, amount, phone_number, provider, stellar_address, user_id, status, reference_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      ["deposit", "2000000", "+237600000001", "orange", "GTEST123", testUserId, "completed", "REF" + Date.now()]
    );
    testTransactionId = transaction.rows[0].id;

    // Create test AML alert
    const alert = await amlAlertModel.create({
      id: crypto.randomUUID(),
      transactionId: testTransactionId,
      userId: testUserId,
      severity: "high",
      status: "pending_review",
      ruleHits: [
        {
          rule: "single_transaction_threshold",
          message: "Transaction exceeds threshold",
          observed: 2000000,
          threshold: 1000000,
        },
      ],
      reasons: ["Transaction exceeds threshold"],
      createdAt: new Date().toISOString(),
    });
    testAlertId = alert.id;
  });

  afterAll(async () => {
    // Cleanup
    await pool.query("DELETE FROM aml_alert_review_history WHERE alert_id = $1", [
      testAlertId,
    ]);
    await pool.query("DELETE FROM aml_alerts WHERE id = $1", [testAlertId]);
    await pool.query("DELETE FROM transactions WHERE id = $1", [
      testTransactionId,
    ]);
    await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
    await pool.end();
  });

  // Helper to create mock request/response
  const createMockReqRes = (
    query: any = {},
    params: any = {},
    body: any = {},
    userId?: string
  ) => {
    const req = {
      query,
      params,
      body,
      jwtUser: userId ? { userId } : undefined,
    } as unknown as Request;

    const res = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    return { req, res };
  };

  describe("List AML Alerts", () => {
    it("should list AML alerts successfully", async () => {
      const { req, res } = createMockReqRes();

      await listAmlAlertsForAudit(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response).toHaveProperty("data");
      expect(response).toHaveProperty("pagination");
      expect(response).toHaveProperty("summary");
      expect(Array.isArray(response.data)).toBe(true);
    });

    it("should filter alerts by status", async () => {
      const { req, res } = createMockReqRes({ status: "pending_review" });

      await listAmlAlertsForAudit(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(
        response.data.every((a: any) => a.status === "pending_review")
      ).toBe(true);
    });

    it("should filter alerts by userId", async () => {
      const { req, res } = createMockReqRes({ userId: testUserId });

      await listAmlAlertsForAudit(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.data.every((a: any) => a.userId === testUserId)).toBe(
        true
      );
    });

    it("should filter alerts by severity", async () => {
      const { req, res } = createMockReqRes({ severity: "high" });

      await listAmlAlertsForAudit(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.data.every((a: any) => a.severity === "high")).toBe(true);
    });

    it("should reject invalid status values", async () => {
      const { req, res } = createMockReqRes({ status: "invalid" });

      await listAmlAlertsForAudit(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe("Search Alerts by User", () => {
    it("should search alerts by userId", async () => {
      const { req, res } = createMockReqRes({ userId: testUserId });

      await searchAmlAlertsByUser(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response).toHaveProperty("data");
      expect(response).toHaveProperty("total");
      expect(response).toHaveProperty("pendingReview");
    });

    it("should search alerts by userId and intensity", async () => {
      const { req, res } = createMockReqRes({
        userId: testUserId,
        intensity: "high",
      });

      await searchAmlAlertsByUser(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.data.every((a: any) => a.severity === "high")).toBe(true);
    });

    it("should require userId parameter", async () => {
      const { req, res } = createMockReqRes({});

      await searchAmlAlertsByUser(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("should reject invalid intensity values", async () => {
      const { req, res } = createMockReqRes({
        userId: testUserId,
        intensity: "invalid",
      });

      await searchAmlAlertsByUser(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe("Get Alert Details", () => {
    it("should get detailed alert information", async () => {
      const { req, res } = createMockReqRes({}, { alertId: testAlertId });

      await getAmlAlertDetails(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response).toHaveProperty("alert");
      expect(response).toHaveProperty("transaction");
      expect(response).toHaveProperty("user");
      expect(response).toHaveProperty("reviewHistory");
      expect(response.alert.id).toBe(testAlertId);
    });

    it("should return 404 for non-existent alert", async () => {
      const fakeId = crypto.randomUUID();
      const { req, res } = createMockReqRes({}, { alertId: fakeId });

      await getAmlAlertDetails(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe("Review Alert", () => {
    it("should review an alert successfully", async () => {
      const { req, res } = createMockReqRes(
        {},
        { alertId: testAlertId },
        {
          status: "reviewed",
          reviewNotes: "Verified transaction is legitimate",
        },
        testUserId
      );

      await reviewAmlAlert(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.alert.status).toBe("reviewed");
      expect(response.alert.reviewNotes).toBe(
        "Verified transaction is legitimate"
      );
      expect(response.alert.reviewedBy).toBe(testUserId);
      expect(response.alert.reviewedAt).toBeDefined();
    });

    it("should dismiss an alert", async () => {
      // First reset to pending
      await pool.query(
        "UPDATE aml_alerts SET status = $1, reviewed_at = NULL, reviewed_by = NULL WHERE id = $2",
        ["pending_review", testAlertId]
      );

      const { req, res } = createMockReqRes(
        {},
        { alertId: testAlertId },
        {
          status: "dismissed",
          reviewNotes: "False positive",
        },
        testUserId
      );

      await reviewAmlAlert(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.alert.status).toBe("dismissed");
    });

    it("should reject invalid status", async () => {
      const { req, res } = createMockReqRes(
        {},
        { alertId: testAlertId },
        {
          status: "invalid",
        },
        testUserId
      );

      await reviewAmlAlert(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("should return 404 for non-existent alert", async () => {
      const fakeId = crypto.randomUUID();
      const { req, res } = createMockReqRes(
        {},
        { alertId: fakeId },
        {
          status: "reviewed",
        },
        testUserId
      );

      await reviewAmlAlert(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it("should require authentication", async () => {
      const { req, res } = createMockReqRes(
        {},
        { alertId: testAlertId },
        {
          status: "reviewed",
        }
      );

      await reviewAmlAlert(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe("Dashboard Statistics", () => {
    it("should return dashboard statistics", async () => {
      const { req, res } = createMockReqRes();

      await getAmlDashboardStats(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response).toHaveProperty("summary");
      expect(response).toHaveProperty("period");
      expect(response.summary).toHaveProperty("total");
      expect(response.summary).toHaveProperty("pendingReview");
      expect(response.summary).toHaveProperty("reviewed");
      expect(response.summary).toHaveProperty("dismissed");
      expect(response.summary).toHaveProperty("highSeverity");
      expect(response.summary).toHaveProperty("mediumSeverity");
    });

    it("should filter stats by date range", async () => {
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const endDate = new Date().toISOString();

      const { req, res } = createMockReqRes({ startDate, endDate });

      await getAmlDashboardStats(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.period.startDate).toBeDefined();
      expect(response.period.endDate).toBeDefined();
    });
  });

  describe("AML Alert Model", () => {
    it("should find alert by id", async () => {
      const alert = await amlAlertModel.findById(testAlertId);
      expect(alert).not.toBeNull();
      expect(alert?.id).toBe(testAlertId);
    });

    it("should get alerts by transaction", async () => {
      const alerts = await amlAlertModel.getAlertsByTransaction(
        testTransactionId
      );
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].transactionId).toBe(testTransactionId);
    });

    it("should get review history", async () => {
      const history = await amlAlertModel.getReviewHistory(testAlertId);
      expect(Array.isArray(history)).toBe(true);
    });
  });
});
