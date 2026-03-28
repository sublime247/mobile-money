import request from "supertest";
import express from "express";
import webhookRoutes from "../webhooks";
import { SAMPLE_WEBHOOK_PAYLOAD } from "../webhooks";

describe("Webhooks Routes", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api/webhooks", webhookRoutes);
    
    // Set test environment variables
    process.env.WEBHOOK_SECRET = "test-webhook-secret";
  });

  afterEach(() => {
    delete process.env.WEBHOOK_SECRET;
  });

  describe("GET /api/webhooks/schema", () => {
    it("should return webhook schema information", async () => {
      const response = await request(app)
        .get("/api/webhooks/schema")
        .expect(200);

      expect(response.body).toHaveProperty("name", "Mobile Money Webhooks");
      expect(response.body).toHaveProperty("description");
      expect(response.body).toHaveProperty("version", "1.0.0");
      expect(response.body).toHaveProperty("events");
      expect(response.body).toHaveProperty("sample_payload");
      expect(response.body).toHaveProperty("schema");
      expect(response.body).toHaveProperty("setup_instructions");

      expect(response.body.events).toContain("transaction.completed");
      expect(response.body.events).toContain("transaction.failed");
      expect(response.body.events).toContain("transaction.pending");
      expect(response.body.events).toContain("transaction.cancelled");

      expect(response.body.sample_payload).toEqual(SAMPLE_WEBHOOK_PAYLOAD);
    });

    it("should include proper schema structure", async () => {
      const response = await request(app)
        .get("/api/webhooks/schema")
        .expect(200);

      const schema = response.body.schema;
      expect(schema.type).toBe("object");
      expect(schema.properties).toHaveProperty("event_id");
      expect(schema.properties).toHaveProperty("event_type");
      expect(schema.properties).toHaveProperty("timestamp");
      expect(schema.properties).toHaveProperty("transaction_id");
      expect(schema.properties).toHaveProperty("amount");
      expect(schema.properties).toHaveProperty("currency");
    });
  });

  describe("GET /api/webhooks/sample", () => {
    it("should return sample webhook payload", async () => {
      const response = await request(app)
        .get("/api/webhooks/sample")
        .expect(200);

      expect(response.body).toEqual(SAMPLE_WEBHOOK_PAYLOAD);
      expect(response.body.event_id).toBe("evt_1234567890");
      expect(response.body.event_type).toBe("transaction.completed");
      expect(response.body.transaction_id).toBe("txn_abc123def456");
    });
  });

  describe("POST /api/webhooks/test", () => {
    it("should echo back the received payload", async () => {
      const testPayload = {
        test: true,
        amount: "100.00",
        transaction_id: "test_123"
      };

      const response = await request(app)
        .post("/api/webhooks/test")
        .send(testPayload)
        .expect(200);

      expect(response.body.received).toBe(true);
      expect(response.body.payload).toEqual(testPayload);
      expect(response.body).toHaveProperty("timestamp");
      expect(response.body.headers).toHaveProperty("content-type", "application/json");
    });

    it("should include headers in test response", async () => {
      const response = await request(app)
        .post("/api/webhooks/test")
        .set("User-Agent", "Test-Agent")
        .set("X-Webhook-Signature", "sha256=test123")
        .send({ test: true })
        .expect(200);

      expect(response.body.headers["user-agent"]).toBe("Test-Agent");
      expect(response.body.headers["x-webhook-signature"]).toBe("sha256=test123");
    });
  });

  describe("POST /api/webhooks", () => {
    beforeEach(() => {
      process.env.WEBHOOK_SECRET = "test-webhook-secret";
    });

    it("should reject webhook when WEBHOOK_SECRET is not configured", async () => {
      delete process.env.WEBHOOK_SECRET;

      const response = await request(app)
        .post("/api/webhooks")
        .send(SAMPLE_WEBHOOK_PAYLOAD)
        .expect(500);

      expect(response.body.error).toBe("Webhook processing not configured");
      expect(response.body).toHaveProperty("setup_url");
    });

    it("should reject webhook with invalid signature", async () => {
      const response = await request(app)
        .post("/api/webhooks")
        .set("X-Webhook-Signature", "invalid-signature")
        .send(SAMPLE_WEBHOOK_PAYLOAD)
        .expect(401);

      expect(response.body.error).toBe("Invalid signature");
    });

    it("should reject webhook with missing signature header", async () => {
      const response = await request(app)
        .post("/api/webhooks")
        .send(SAMPLE_WEBHOOK_PAYLOAD)
        .expect(401);

      expect(response.body.error).toBe("Invalid signature");
    });

    it("should reject webhook with missing required fields", async () => {
      const invalidPayload = {
        event_type: "transaction.completed",
        // Missing transaction_id
      };

      const crypto = require("crypto");
      const signature = `sha256=${crypto
        .createHmac("sha256", process.env.WEBHOOK_SECRET)
        .update(JSON.stringify(invalidPayload))
        .digest("hex")}`;

      const response = await request(app)
        .post("/api/webhooks")
        .set("X-Webhook-Signature", signature)
        .send(invalidPayload)
        .expect(400);

      expect(response.body.error).toBe("Missing required fields");
    });

    it("should return 404 for non-existent transaction", async () => {
      const payload = {
        ...SAMPLE_WEBHOOK_PAYLOAD,
        transaction_id: "non-existent-id"
      };

      const crypto = require("crypto");
      const signature = `sha256=${crypto
        .createHmac("sha256", process.env.WEBHOOK_SECRET)
        .update(JSON.stringify(payload))
        .digest("hex")}`;

      const response = await request(app)
        .post("/api/webhooks")
        .set("X-Webhook-Signature", signature)
        .send(payload)
        .expect(404);

      expect(response.body.error).toBe("Transaction not found");
      expect(response.body.transaction_id).toBe("non-existent-id");
    });

    it("should accept valid webhook payload", async () => {
      const payload = {
        event_id: "evt_test123",
        event_type: "transaction.completed",
        timestamp: "2026-03-27T11:46:00.000Z",
        transaction_id: "test_txn_123",
        reference_number: "REF-TEST-001",
        transaction_type: "deposit",
        amount: "100.00",
        currency: "USD",
        phone_number: "+1234567890",
        provider: "mpesa",
        stellar_address: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
        status: "completed",
        created_at: "2026-03-27T11:45:00.000Z"
      };

      const crypto = require("crypto");
      const signature = `sha256=${crypto
        .createHmac("sha256", process.env.WEBHOOK_SECRET)
        .update(JSON.stringify(payload))
        .digest("hex")}`;

      const response = await request(app)
        .post("/api/webhooks")
        .set("X-Webhook-Signature", signature)
        .send(payload)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.event_id).toBe("evt_test123");
      expect(response.body.transaction_id).toBe("test_txn_123");
      expect(response.body).toHaveProperty("processed_at");
    });

    it("should handle valid webhook with optional fields", async () => {
      const payload = {
        event_id: "evt_test456",
        event_type: "transaction.failed",
        timestamp: "2026-03-27T11:46:00.000Z",
        transaction_id: "test_txn_456",
        reference_number: "REF-TEST-002",
        transaction_type: "withdraw",
        amount: "50.00",
        currency: "USD",
        phone_number: "+0987654321",
        provider: "airtel",
        stellar_address: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
        status: "failed",
        user_id: "user_123",
        notes: "Test failed transaction",
        tags: "test,failed",
        created_at: "2026-03-27T11:40:00.000Z",
        updated_at: "2026-03-27T11:46:00.000Z",
        metadata_key: "error_code",
        metadata_value: "INSUFFICIENT_FUNDS"
      };

      const crypto = require("crypto");
      const signature = `sha256=${crypto
        .createHmac("sha256", process.env.WEBHOOK_SECRET)
        .update(JSON.stringify(payload))
        .digest("hex")}`;

      const response = await request(app)
        .post("/api/webhooks")
        .set("X-Webhook-Signature", signature)
        .send(payload)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.event_id).toBe("evt_test456");
      expect(response.body.transaction_id).toBe("test_txn_456");
    });
  });
});
