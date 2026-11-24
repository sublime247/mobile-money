import request from "supertest";
import express, { Express } from "express";
import { Asset } from "@stellar/stellar-sdk";
import sep31Router from "../sep31";
import { errorHandler } from "../../middleware/errorHandler";
import { validateNationalId } from "../../validators/nationalIdValidator";

jest.mock("../../services/ipReputation", () => ({
  ipReputationService: {
    checkIP: jest.fn().mockResolvedValue({ isTorExitNode: false }),
  },
}));
jest.mock("../../services/stellar/assetService", () => ({
  getConfiguredPaymentAsset: jest.fn(() => Asset.native()),
}));
jest.mock("../../middleware/idempotency", () => ({
  strictIdempotency: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../models/users", () => ({
  UserModel: jest.fn().mockImplementation(() => ({
    findById: jest.fn().mockResolvedValue({ kycLevel: "full" }),
  })),
}));
jest.mock("../../models/transaction", () => ({
  TransactionModel: jest.fn().mockImplementation(() => ({
    create: jest.fn().mockResolvedValue({ id: "tx-1" }),
  })),
  TransactionStatus: { Pending: "pending", Review: "review" },
}));
jest.mock("../../services/sanctionService", () => ({
  sanctionService: {
    searchSanctionsWithLevenshtein: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock("../../services/amlScreening", () => ({
  PENDING_COMPLIANCE_REVIEW: "pending_compliance_review",
  amlScreeningService: {
    getDailyVolumeUsd: jest.fn().mockResolvedValue(0),
    screenParties: jest.fn().mockResolvedValue({ flagged: false }),
  },
}));
jest.mock("../../services/webhookService", () => ({
  notifyReceivingAnchorStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../config/database", () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

const VALID_IDS: Array<{
  country: string;
  alpha3: string;
  id: string;
  phone: string;
}> = [
  {
    country: "GH",
    alpha3: "GHA",
    id: "GHA-123456789-1",
    phone: "+233241234567",
  },
  { country: "KE", alpha3: "KEN", id: "12345678", phone: "+254712345678" },
  { country: "NG", alpha3: "NGA", id: "12345678901", phone: "+2348012345678" },
  { country: "SN", alpha3: "SEN", id: "1234567890123", phone: "+221771234567" },
];

function makeBody(
  country: string,
  senderId: string,
  receiverId: string,
  phone: string,
  extra: Record<string, any> = {},
): any {
  return {
    amount: "100",
    asset_code: "XLM",
    sender_id: "sender-1",
    receiver_id: "receiver-1",
    country_code: country,
    fields: {
      sender: {
        first_name: "Alice",
        last_name: "Smith",
        id_number: senderId,
        mobile_number: phone,
      },
      receiver: {
        first_name: "Bob",
        last_name: "Jones",
        mobile_number: phone,
        id_number: receiverId,
      },
    },
    ...extra,
  };
}

describe("SEP-31 national ID format validation (#2429)", () => {
  let app: Express;

  beforeAll(() => {
    process.env.STELLAR_RECEIVING_ACCOUNT =
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    app = express();
    app.use(express.json());
    app.use("/sep31", sep31Router);
    app.use(errorHandler);
  });

  afterAll(() => {
    delete process.env.STELLAR_RECEIVING_ACCOUNT;
  });

  describe("validateNationalId rule set", () => {
    it.each([
      ["GH", "GHA-123456789-1"],
      ["GHA", "GHA-123456789-X"],
      ["KE", "1234567"],
      ["KEN", "12345678"],
      ["NG", "12345678901"],
      ["NGA", "12345678901"],
      ["SN", "1234567890123"],
      ["SEN", "1234567890123"],
    ])("accepts a valid %s ID (%s)", (country, id) => {
      expect(validateNationalId(id, country).valid).toBe(true);
    });

    it.each([
      ["GH", "12345678901"],
      ["GHA", "GHA-12345678-1"],
      ["GHA", "GHA-123456789-11"],
      ["KE", "123456"],
      ["KEN", "123456789"],
      ["NG", "1234567890"],
      ["NGA", "123456789012"],
      ["SN", "123456789012"],
      ["SEN", "12345678901234"],
    ])("rejects a malformed %s ID (%s)", (country, id) => {
      const result = validateNationalId(id, country, "fields.sender.id_number");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("fields.sender.id_number");
    });

    it("trims surrounding whitespace before validating", () => {
      expect(validateNationalId("  12345678901  ", "NG").valid).toBe(true);
    });

    it("does not enforce unsupported countries or missing IDs", () => {
      expect(validateNationalId("anything-goes", "US").valid).toBe(true);
      expect(validateNationalId(undefined, "NG").valid).toBe(true);
      expect(validateNationalId("", "GHA").valid).toBe(true);
      expect(validateNationalId("123", undefined).valid).toBe(true);
    });
  });

  describe("POST /sep31/transactions", () => {
    it.each(VALID_IDS)(
      "accepts valid sender and receiver IDs for $country",
      async ({ country, id, phone }) => {
        const res = await request(app)
          .post("/sep31/transactions")
          .send(makeBody(country, id, id, phone));

        expect(res.status).toBe(201);
        expect(res.body.id).toBe("tx-1");
      },
    );

    it("uses id_country_code instead of the corridor country when provided", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send(
          makeBody("NG", "12345678", "1234567890123", "+2348012345678", {
            fields: {
              sender: {
                first_name: "Alice",
                last_name: "Smith",
                id_number: "12345678",
                id_country_code: "KEN",
                mobile_number: "+2348012345678",
              },
              receiver: {
                first_name: "Bob",
                last_name: "Jones",
                mobile_number: "+2348012345678",
                id_number: "1234567890123",
                id_country_code: "SEN",
              },
            },
          }),
        );

      expect(res.status).toBe(201);
    });

    it("returns a field-specific 400 for a malformed sender ID", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send(makeBody("GH", "12345678901", "GHA-123456789-1", "+233241234567"));

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("fields.sender.id_number");
      expect(res.body.details.details.invalidFields).toContain(
        "fields.sender.id_number",
      );
    });

    it("returns a field-specific 400 for a malformed receiver ID", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send(makeBody("NG", "12345678901", "12345", "+2348012345678"));

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("fields.receiver.id_number");
      expect(res.body.details.details.invalidFields).toContain(
        "fields.receiver.id_number",
      );
    });

    it("reports both parties when both IDs are malformed", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send(makeBody("NG", "123", "456", "+2348012345678"));

      expect(res.status).toBe(400);
      expect(res.body.details.details.invalidFields).toEqual([
        "fields.sender.id_number",
        "fields.receiver.id_number",
      ]);
    });

    it("does not reject IDs for unsupported countries", async () => {
      const res = await request(app)
        .post("/sep31/transactions")
        .send(makeBody("NG", "not-a-nin", "also-not-a-nin", "+2348012345678", {
          fields: {
            sender: {
              first_name: "Alice",
              last_name: "Smith",
              id_number: "not-a-nin",
              id_country_code: "US",
              mobile_number: "+2348012345678",
            },
            receiver: {
              first_name: "Bob",
              last_name: "Jones",
              mobile_number: "+2348012345678",
              id_number: "also-not-a-nin",
              id_country_code: "US",
            },
          },
        }));

      expect(res.status).toBe(201);
    });

    it("skips validation when the ID number is absent", async () => {
      const body = makeBody("NG", "12345678901", "12345678901", "+2348012345678");
      delete body.fields.receiver.id_number;

      const res = await request(app)
        .post("/sep31/transactions")
        .send(body);

      expect(res.status).toBe(201);
    });
  });
});
