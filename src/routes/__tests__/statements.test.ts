import request from "supertest";
import app from "../../index";
import { pool } from "../../config/database";
import jwt from "jsonwebtoken";

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

jest.mock("../../config/database", () => ({
  pool: {
    connect: jest.fn().mockImplementation(() => Promise.resolve(mockClient)),
    query: jest.fn(),
  },
}));

jest.mock("../../utils/encryption", () => ({
  decrypt: jest.fn((val) => val),
  encrypt: jest.fn((val) => val),
}));

jest.mock("../../middleware/auth", () => ({
  requireAuth: jest.fn((req, res, next) => {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    req.user = { id: "user-123" };
    next();
  }),
  authenticateToken: jest.fn((req, res, next) => next()),
}));

// Mock the PDF generation to avoid actual PDF creation in tests
jest.mock("jspdf", () => {
  return jest.fn().mockImplementation(() => ({
    internal: {
      pageSize: {
        width: 210,
        height: 297,
      },
    },
    setFontSize: jest.fn(),
    setFont: jest.fn(),
    text: jest.fn(),
    setDrawColor: jest.fn(),
    rect: jest.fn(),
    output: jest.fn().mockReturnValue(Buffer.from("mock-pdf-content")),
  }));
});

jest.mock("jspdf-autotable", () => jest.fn());

describe("Statements Routes", () => {
  let authToken: string;
  let userId: string;

  beforeAll(async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ id: "user-123" }]
    });

    // Create a test user
    const userResult = await pool.query(
      "INSERT INTO users (phone_number, kyc_level) VALUES ($1, $2) RETURNING id",
      ["1234567890", "basic"]
    );
    userId = userResult.rows[0].id;

    // Generate auth token
    authToken = jwt.sign(
      { id: userId, phoneNumber: "1234567890" },
      process.env.JWT_SECRET || "test-secret",
      { expiresIn: "1h" }
    );
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query("DELETE FROM transactions WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  });

  describe("GET /api/statements/monthly/:year/:month", () => {
    it("should require authentication", async () => {
      const response = await request(app)
        .get("/api/statements/monthly/2024/01")
        .expect(401);

      expect(response.body.error).toBe("User not authenticated");
    });

    it("should validate year and month parameters", async () => {
      const response = await request(app)
        .get("/api/statements/monthly/invalid/month")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(400);

      expect(response.body.error).toBe("Invalid year or month");
    });

    it("should return 404 when no data found", async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] }); // User query returns empty

      const response = await request(app)
        .get("/api/statements/monthly/2024/01")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.error).toBe("No data found for the specified period");
    });

    it("should generate PDF statement when data exists", async () => {
      // 1. User query
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: userId, phone_number: "1234567890", kyc_level: "basic" }]
      });
      // 2. Transactions query
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: "tx-1",
            referenceNumber: "TEST123",
            type: "deposit",
            amount: "100.00",
            currency: "USD",
            provider: "test-provider",
            status: "completed",
            createdAt: new Date("2024-01-15"),
          }
        ]
      });
      // 3. Opening balance query
      mockClient.query.mockResolvedValueOnce({
        rows: [{ opening_balance: "0.00" }]
      });

      // Create a test transaction
      await pool.query(
        `INSERT INTO transactions 
         (user_id, reference_number, type, amount, phone_number, provider, stellar_address, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          userId,
          "TEST123",
          "deposit",
          "100.00",
          "1234567890",
          "test-provider",
          "GTEST123",
          "completed",
          new Date("2024-01-15"),
        ]
      );

      const response = await request(app)
        .get("/api/statements/monthly/2024/01")
        .set("Authorization", `Bearer ${authToken}`)
        .expect(200);

      expect(response.headers["content-type"]).toBe("application/pdf");
      expect(response.headers["content-disposition"]).toContain("statement-2024-01.pdf");
    });
  });
});