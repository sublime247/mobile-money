import express from "express";
import request from "supertest";

const exportForCompliance = jest.fn();
const findByTransactionId = jest.fn();

jest.mock("../../middleware/auth", () => ({
  requireAuth: jest.fn((req: any, _res: any, next: () => void) => {
    req.user = { id: "admin-1", role: "admin" };
    next();
  }),
}));

jest.mock("../../compliance/travelRule", () => ({
  travelRuleService: {
    exportForCompliance,
    findByTransactionId,
  },
}));

jest.mock("../../controllers/complianceController", () => ({
  travelRuleCheckHandler: (_req: any, res: any) => {
    res.status(200).json({ ok: true });
  },
}));

import { travelRuleRoutes } from "../travelRule";

describe("travelRuleRoutes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(travelRuleRoutes);
    return app;
  }

  it("exports travel-rule records as JSON and CSV", async () => {
    exportForCompliance.mockResolvedValue([
      {
        id: "record-1",
        transactionId: "txn-1",
        amount: 25,
        currency: "USD",
        sender: {
          name: "Alice",
          account: "acct-1",
          address: "1 Main St",
          dob: "1990-01-01",
          idNumber: "123456",
        },
        receiver: {
          name: "Bob",
          account: "acct-2",
          address: "2 Main St",
        },
        originatingVasp: "VASP A",
        beneficiaryVasp: "VASP B",
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        exportedAt: new Date("2024-01-02T00:00:00.000Z"),
        exportedBy: "admin-1",
      },
    ]);

    const jsonResponse = await request(buildApp()).get("/?from=2024-01-01&to=2024-01-31&onlyUnexported=true");
    expect(jsonResponse.status).toBe(200);
    expect(jsonResponse.body.count).toBe(1);
    expect(jsonResponse.body.records[0].sender.address).toBe("1 Main St");

    const csvResponse = await request(buildApp()).get("/export.csv");
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers["content-type"]).toContain("text/csv");
    expect(csvResponse.text).toContain("Sender Name");
    expect(csvResponse.text).toContain("Alice");
  });

  it("returns a single travel-rule record by transaction id", async () => {
    findByTransactionId.mockResolvedValue(null);
    const missing = await request(buildApp()).get("/txn-404");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "No Travel Rule record for this transaction" });

    const record = {
      id: "record-2",
      transactionId: "txn-2",
      amount: 10,
      currency: "USD",
      sender: { name: "Alice", account: "acct-1", address: null, dob: null, idNumber: null },
      receiver: { name: "Bob", account: "acct-2", address: null },
      originatingVasp: null,
      beneficiaryVasp: null,
      createdAt: new Date("2024-01-03T00:00:00.000Z"),
      exportedAt: null,
      exportedBy: null,
    };
    findByTransactionId.mockResolvedValueOnce(record);

    const found = await request(buildApp()).get("/txn-2");
    expect(found.status).toBe(200);
    expect(found.body.transactionId).toBe("txn-2");
  });

  it("validates and serializes IVMS 101 data before returning an exchange payload", async () => {
    const response = await request(buildApp())
      .post("/ivms101")
      .send({
        originatorName: "Alice Smith",
        originatorAccount: "originator-account",
        originatorAddress: {
          street: "1 Main Street",
          city: "London",
          postCode: "SW1A 1AA",
          country: "GB",
        },
        beneficiaryName: "Bob Jones",
        beneficiaryAccount: "beneficiary-account",
        amount: 1500,
        currency: "USD",
      });

    expect(response.status).toBe(200);
    expect(response.body.travelRuleRequired).toBe(true);
    expect(response.body.ivms101.IVMS101Version).toBe("2019-01-21");
    expect(
      response.body.ivms101.originator.originatorPersons[0].naturalPerson
        .geographicAddress[0],
    ).toMatchObject({
      streetName: "1 Main Street",
      townName: "London",
      country: "GB",
    });
  });

  it("returns JSON pointer errors for incomplete originator identity data", async () => {
    const response = await request(buildApp()).post("/ivms101").send({
      originatorName: "Alice Smith",
      originatorAccount: "originator-account",
      beneficiaryName: "Bob Jones",
      beneficiaryAccount: "beneficiary-account",
    });

    expect(response.status).toBe(422);
    expect(response.body.details).toContainEqual(
      expect.objectContaining({
        path: "/originator/originatorPersons/0/naturalPerson/nationalIdentification",
      }),
    );
  });
});
