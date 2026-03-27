import request from "supertest";
import app from "../../src/index";
import { pool } from "../../src/config/database";
import { redisClient } from "../../src/config/redis";

// Mock the database and redis
jest.mock("../../src/config/database");
jest.mock("../../src/config/redis");

const mockPool = pool as jest.Mocked<typeof pool>;
const mockRedisClient = redisClient as jest.Mocked<typeof redisClient>;

describe("Fees API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisClient.isOpen = true;
  });

  describe("POST /api/fees/calculate", () => {
    it("should calculate fee using fallback when service fails", async () => {
      const response = await request(app)
        .post("/api/fees/calculate")
        .send({ amount: 10000 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.fee).toBe(150);
      expect(response.body.data.total).toBe(10150);
      expect(response.body.data.configUsed).toBe('env_fallback');
    });

    it("should return validation error for invalid amount", async () => {
      const response = await request(app)
        .post("/api/fees/calculate")
        .send({ amount: -100 });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Validation error");
    });
  });

  describe("GET /api/fees/configurations/active", () => {
    it("should return error when no active configuration found", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get("/api/fees/configurations/active");

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });
});