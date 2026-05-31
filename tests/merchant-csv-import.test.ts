import request from "supertest";
import express from "express";
import { merchantRoutes } from "../src/routes/merchants";

// Mock dependencies
const mockCheckExistingEmails = jest.fn();
const mockBatchInsert = jest.fn();

jest.mock("../src/models/merchant", () => {
  return {
    MerchantModel: jest.fn().mockImplementation(() => {
      return {
        checkExistingEmails: mockCheckExistingEmails,
        batchInsert: mockBatchInsert,
      };
    }),
  };
});

jest.mock("../src/middleware/auth", () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    // Simulate valid auth token verification by setting jwtUser
    req.jwtUser = { userId: "test-user-id" };
    next();
  },
}));

describe("Merchant CSV Import Endpoint (merchant-csv-import)", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/merchants", merchantRoutes);
  });

  it("should successfully import valid merchants", async () => {
    const csvContent =
      "email,name,business_type\n" +
      "merchant1@example.com,Merchant One,Retail\n" +
      "merchant2@example.com,Merchant Two,Services\n";

    mockCheckExistingEmails.mockResolvedValue(new Set());
    mockBatchInsert.mockResolvedValue(undefined);

    const response = await request(app)
      .post("/api/merchants/bulk")
      .attach("file", Buffer.from(csvContent), "merchants.csv");

    expect(response.status).toBe(200);
    expect(response.body.successful_rows).toHaveLength(2);
    expect(response.body.failed_rows).toHaveLength(0);

    expect(response.body.successful_rows[0]).toEqual({
      row: 2,
      email: "merchant1@example.com",
      name: "Merchant One",
      business_type: "Retail",
    });
    expect(response.body.successful_rows[1]).toEqual({
      row: 3,
      email: "merchant2@example.com",
      name: "Merchant Two",
      business_type: "Services",
    });

    expect(mockCheckExistingEmails).toHaveBeenCalledWith([
      "merchant1@example.com",
      "merchant2@example.com",
    ]);
    expect(mockBatchInsert).toHaveBeenCalledWith([
      {
        row: 2,
        email: "merchant1@example.com",
        name: "Merchant One",
        business_type: "Retail",
      },
      {
        row: 3,
        email: "merchant2@example.com",
        name: "Merchant Two",
        business_type: "Services",
      },
    ]);
  });

  it("should handle duplicate emails in the CSV itself", async () => {
    const csvContent =
      "email,name,business_type\n" +
      "dup@example.com,Merchant Dup,Retail\n" +
      "dup@example.com,Merchant Dup,Retail\n" +
      "unique@example.com,Merchant Unique,Services\n";

    mockCheckExistingEmails.mockResolvedValue(new Set());
    mockBatchInsert.mockResolvedValue(undefined);

    const response = await request(app)
      .post("/api/merchants/bulk")
      .attach("file", Buffer.from(csvContent), "merchants.csv");

    expect(response.status).toBe(200);
    expect(response.body.successful_rows).toHaveLength(2);
    expect(response.body.failed_rows).toHaveLength(1);

    expect(response.body.failed_rows[0]).toEqual({
      row: 3,
      error: "Duplicate merchant email in CSV: dup@example.com",
    });

    expect(response.body.successful_rows[0]).toEqual({
      row: 2,
      email: "dup@example.com",
      name: "Merchant Dup",
      business_type: "Retail",
    });
    expect(response.body.successful_rows[1]).toEqual({
      row: 4,
      email: "unique@example.com",
      name: "Merchant Unique",
      business_type: "Services",
    });

    expect(mockCheckExistingEmails).toHaveBeenCalledWith([
      "dup@example.com",
      "unique@example.com",
    ]);
  });

  it("should handle database duplicate checks (integrity test)", async () => {
    const csvContent =
      "email,name,business_type\n" +
      "existing@example.com,Merchant Existing,Retail\n" +
      "new@example.com,Merchant New,Services\n";

    mockCheckExistingEmails.mockResolvedValue(
      new Set(["existing@example.com"]),
    );
    mockBatchInsert.mockResolvedValue(undefined);

    const response = await request(app)
      .post("/api/merchants/bulk")
      .attach("file", Buffer.from(csvContent), "merchants.csv");

    expect(response.status).toBe(200);
    expect(response.body.successful_rows).toHaveLength(1);
    expect(response.body.failed_rows).toHaveLength(1);

    expect(response.body.failed_rows[0]).toEqual({
      row: 2,
      error: "Duplicate merchant email in database: existing@example.com",
    });

    expect(response.body.successful_rows[0]).toEqual({
      row: 3,
      email: "new@example.com",
      name: "Merchant New",
      business_type: "Services",
    });

    expect(mockBatchInsert).toHaveBeenCalledWith([
      {
        row: 3,
        email: "new@example.com",
        name: "Merchant New",
        business_type: "Services",
      },
    ]);
  });

  it("should identify schema validation failures without crashing for valid rows", async () => {
    const csvContent =
      "email,name,business_type\n" +
      "invalid-email,Merchant,Retail\n" +
      ",Merchant No Email,Retail\n" +
      "valid@example.com,,Services\n" +
      "valid2@example.com,Merchant Two,\n" +
      "valid3@example.com,Merchant Three,Fintech\n";

    mockCheckExistingEmails.mockResolvedValue(new Set());
    mockBatchInsert.mockResolvedValue(undefined);

    const response = await request(app)
      .post("/api/merchants/bulk")
      .attach("file", Buffer.from(csvContent), "merchants.csv");

    expect(response.status).toBe(200);
    expect(response.body.successful_rows).toHaveLength(1);
    expect(response.body.failed_rows).toHaveLength(4);

    expect(response.body.failed_rows).toContainEqual({
      row: 2,
      error: "Invalid or missing email: invalid-email",
    });
    expect(response.body.failed_rows).toContainEqual({
      row: 3,
      error: "Invalid or missing email: ",
    });
    expect(response.body.failed_rows).toContainEqual({
      row: 4,
      error: "Missing merchant name",
    });
    expect(response.body.failed_rows).toContainEqual({
      row: 5,
      error: "Missing business type",
    });

    expect(response.body.successful_rows[0]).toEqual({
      row: 6,
      email: "valid3@example.com",
      name: "Merchant Three",
      business_type: "Fintech",
    });

    expect(mockBatchInsert).toHaveBeenCalledWith([
      {
        row: 6,
        email: "valid3@example.com",
        name: "Merchant Three",
        business_type: "Fintech",
      },
    ]);
  });

  it("should handle flexible headers mapping case and spacers", async () => {
    const csvContent =
      "EMAIL,NAME,Business Type\n" +
      "header@example.com,Merchant Header,Agriculture\n";

    mockCheckExistingEmails.mockResolvedValue(new Set());
    mockBatchInsert.mockResolvedValue(undefined);

    const response = await request(app)
      .post("/api/merchants/bulk")
      .attach("file", Buffer.from(csvContent), "merchants.csv");

    expect(response.status).toBe(200);
    expect(response.body.successful_rows).toHaveLength(1);
    expect(response.body.successful_rows[0].business_type).toBe("Agriculture");
  });

  it("should process 100 rows (stress test) in under 2 seconds", async () => {
    let csvContent = "email,name,business_type\n";
    for (let i = 1; i <= 100; i++) {
      csvContent += `merchant${i}@example.com,Merchant ${i},Retail\n`;
    }

    mockCheckExistingEmails.mockResolvedValue(new Set());
    mockBatchInsert.mockResolvedValue(undefined);

    const startTime = performance.now();

    const response = await request(app)
      .post("/api/merchants/bulk")
      .attach("file", Buffer.from(csvContent), "merchants.csv");

    const endTime = performance.now();
    const durationMs = endTime - startTime;

    expect(response.status).toBe(200);
    expect(response.body.successful_rows).toHaveLength(100);
    expect(response.body.failed_rows).toHaveLength(0);

    console.log(
      `[Stress Test] Processed 100 merchants in ${durationMs.toFixed(2)}ms`,
    );
    expect(durationMs).toBeLessThan(2000); // Must be < 2 seconds (2000ms)
  });
});
