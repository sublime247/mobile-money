import express from "express";
import { Readable } from "stream";
import request from "supertest";
import {
  buildTransactionExportQuery,
  createExportRoutes,
} from "../../src/routes/export";

describe("GET /api/transactions/export", () => {
  const adminKey = "test-admin-key";

  beforeAll(() => {
    process.env.ADMIN_API_KEY = adminKey;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("streams CSV with headers, auth, and escaping", async () => {
    const release = jest.fn();
    const rowStream = Readable.from([
      {
        id: "abc-123",
        reference_number: "REF-123",
        type: "deposit",
        amount: "10000",
        phone_number: "+237600000000",
        provider: "MTN",
        status: "completed",
        stellar_address: "GB123",
        tags: ["priority", "vip"],
        notes: 'Needs, review "today"',
        admin_notes: "checked",
        user_id: "user-1",
        created_at: new Date("2026-03-22T10:30:00Z"),
        updated_at: new Date("2026-03-22T10:45:00Z"),
      },
    ]);

    const connect = jest.fn().mockResolvedValue({
      query: jest.fn().mockReturnValue(rowStream),
      release,
    });

    const app = express();
    app.use(
      "/api/transactions",
      createExportRoutes({
        db: { connect },
        createQueryStream: (text, values) => ({ text, values }),
      }),
    );

    const response = await request(app)
      .get("/api/transactions/export")
      .set("X-API-Key", adminKey);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/csv/);
    expect(response.headers["content-disposition"]).toContain("attachment;");
    expect(response.text).toContain(
      "ID,Reference Number,Type,Amount,Phone Number,Provider,Status,Stellar Address,Tags,Notes,Admin Notes,User ID,Created At,Updated At",
    );
    expect(response.text).toContain('"Needs, review ""today"""');
    expect(response.text).toContain("priority|vip");
    expect(release).toHaveBeenCalled();
  });

  it("streams JSON array when format=json", async () => {
    const release = jest.fn();
    const rows = [
      { id: "1", reference_number: "REF1" },
      { id: "2", reference_number: "REF2" },
    ];
    const rowStream = Readable.from(rows);

    const connect = jest.fn().mockResolvedValue({
      query: jest.fn().mockReturnValue(rowStream),
      release,
    });

    const app = express();
    app.use(
      "/api/transactions",
      createExportRoutes({
        db: { connect },
        createQueryStream: (text, values) => ({ text, values }),
      }),
    );

    const response = await request(app)
      .get("/api/transactions/export")
      .query({ format: "json" })
      .set("X-API-Key", adminKey);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    const parsed = JSON.parse(response.text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("1");
    expect(parsed[1].id).toBe("2");
    expect(release).toHaveBeenCalled();
  });

  it("returns 401 without admin auth", async () => {
    const app = express();
    app.use(
      "/api/transactions",
      createExportRoutes({
        db: {
          connect: jest.fn(),
        },
        createQueryStream: (text, values) => ({ text, values }),
      }),
    );

    const response = await request(app).get("/api/transactions/export");

    expect(response.status).toBe(401);
  });

  it("respects filters when building the export query", () => {
    const result = buildTransactionExportQuery({
      status: "completed" as any,
      provider: "MTN",
      type: "deposit",
      phoneNumber: "+237600000000",
      stellarAddress: "GB123",
      referenceNumber: "REF-123",
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-03-31T23:59:59Z"),
      tags: ["vip", "priority"],
    });

    expect(result.text).toContain("status = $1");
    expect(result.text).toContain("provider = $2");
    expect(result.text).toContain("type = $3");
    expect(result.text).toContain("phone_number = $4");
    expect(result.text).toContain("stellar_address = $5");
    expect(result.text).toContain("reference_number = $6");
    expect(result.text).toContain("created_at >= $7");
    expect(result.text).toContain("created_at <= $8");
    expect(result.text).toContain("tags @> $9::text[]");
    expect(result.values).toHaveLength(9);
  });
});
