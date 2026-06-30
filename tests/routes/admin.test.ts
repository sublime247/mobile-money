import express, { Request, Response, NextFunction } from "express";
import request from "supertest";

// Mock the dependencies before importing adminRoutes
jest.mock("../../src/controllers/transactionController", () => ({
  updateAdminNotesHandler: (req: Request, res: Response) => {
    res.json({ message: "mocked" });
  },
  refundTransactionHandler: (req: Request, res: Response) => {
    const { id } = req.params;
    if (id === "not-found") {
      return res.status(404).json({ error: "Transaction not found" });
    }
    if (id === "not-failed") {
      return res.status(400).json({
        error:
          "Cannot refund transaction with status 'pending'. Only failed transactions are eligible.",
      });
    }
    if (id === "not-withdraw") {
      return res
        .status(400)
        .json({ error: "Only withdrawal transactions can be refunded" });
    }
    return res.json({
      message: "Refund processed successfully",
      transactionId: id,
      originalAmount: 1000,
      feeDeducted: 15,
      refundAmount: 985,
    });
  },
}));

jest.mock("../../src/queue/transactionQueue", () => ({
  getQueueStats: jest.fn().mockResolvedValue({
    waiting: 5,
    active: 2,
    completed: 100,
    failed: 0,
    isPaused: false,
  }),
}));

jest.mock("../../src/config/database", () => ({
  checkReplicaHealth: jest.fn().mockResolvedValue([
    { url: "replica1", healthy: true },
    { url: "replica2", healthy: true },
  ]),
}));

// Now safe to import adminRoutes
import { adminRoutes } from "../../src/routes/admin";

describe("Admin Routes - Provider Health", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Mock auth middleware for testing
    // Tests will use this to set user context
    app.use((req: Request, res: Response, next: NextFunction) => {
      // If test provides ?mockAdmin=true, set admin user
      if (req.query.mockAdmin === "true") {
        (req as any).user = { id: "admin-1", role: "admin" };
      } else if (req.query.mockUser === "true") {
        (req as any).user = { id: "user-1", role: "user" };
      }
      next();
    });

    app.use("/api/admin", adminRoutes);
  });

  describe("GET /api/admin/providers/health", () => {
    it("should return 403 when user is not authenticated", async () => {
      const response = await request(app).get("/api/admin/providers/health");

      expect(response.status).toBe(403);
      expect(response.body.message).toBe("Admin access required");
    });

    it("should return 200 and include expected keys when admin is authenticated", async () => {
      const response = await request(app)
        .get("/api/admin/providers/health")
        .query({ mockAdmin: "true" });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("status");
      expect(response.body).toHaveProperty("timestamp");
      expect(response.body).toHaveProperty("providers");
      expect(response.body).toHaveProperty("queue");
      expect(response.body).toHaveProperty("redis");
      expect(response.body).toHaveProperty("database");
    });

    it("should return aggregated health data structure", async () => {
      const response = await request(app)
        .get("/api/admin/providers/health")
        .query({ mockAdmin: "true" });

      expect(response.status).toBe(200);

      // Validate structure
      expect(typeof response.body.timestamp).toBe("string");
      expect(typeof response.body.status).toBe("string");

      // Providers should be an object
      expect(typeof response.body.providers).toBe("object");

      // Queue should have status and stats
      expect(response.body.queue).toHaveProperty("status");
      expect(response.body.queue).toHaveProperty("stats");

      // Redis should have status
      expect(response.body.redis).toHaveProperty("status");

      // Database should have primary and replicas
      expect(response.body.database).toHaveProperty("primary");
      expect(Array.isArray(response.body.database.replicas)).toBe(true);
    });
  });
});

describe("Admin Routes - Refund Transaction", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.query.mockAdmin === "true") {
        (req as any).user = { id: "admin-1", role: "admin" };
      } else if (req.query.mockUser === "true") {
        (req as any).user = { id: "user-1", role: "user" };
      }
      next();
    });

    app.use("/api/admin", adminRoutes);
  });

  describe("POST /api/admin/transactions/:id/refund", () => {
    it("should return 403 when user is not an admin", async () => {
      const response = await request(app)
        .post("/api/admin/transactions/tx-123/refund")
        .query({ mockUser: "true" });

      expect(response.status).toBe(403);
      expect(response.body.message).toBe("Admin access required");
    });

    it("should return 403 when unauthenticated", async () => {
      const response = await request(app).post(
        "/api/admin/transactions/tx-123/refund",
      );

      expect(response.status).toBe(403);
    });

    it("should return 404 when transaction is not found", async () => {
      const response = await request(app)
        .post("/api/admin/transactions/not-found/refund")
        .query({ mockAdmin: "true" });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Transaction not found");
    });

    it("should return 400 when transaction is not in failed status", async () => {
      const response = await request(app)
        .post("/api/admin/transactions/not-failed/refund")
        .query({ mockAdmin: "true" });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(
        /Only failed transactions are eligible/,
      );
    });

    it("should return 400 when transaction is not a withdrawal", async () => {
      const response = await request(app)
        .post("/api/admin/transactions/not-withdraw/refund")
        .query({ mockAdmin: "true" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe(
        "Only withdrawal transactions can be refunded",
      );
    });

    it("should process refund and return refund details for a valid failed withdrawal", async () => {
      const response = await request(app)
        .post("/api/admin/transactions/tx-valid/refund")
        .query({ mockAdmin: "true" });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Refund processed successfully");
      expect(response.body).toHaveProperty("transactionId");
      expect(response.body).toHaveProperty("originalAmount");
      expect(response.body).toHaveProperty("feeDeducted");
      expect(response.body).toHaveProperty("refundAmount");
      expect(response.body.refundAmount).toBeLessThan(
        response.body.originalAmount,
      );
    });
  });
});
