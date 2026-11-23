import request from "supertest";
import express, { Express } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { createSep6Router } from "../sep6";
import { validateCemacRib } from "../../utils/bankValidator";

jest.mock("../sep12", () => ({
  Sep12Service: jest.fn().mockImplementation(() => ({
    getCustomer: jest.fn().mockResolvedValue({
      id: "customer-1",
      status: "accepted",
      fields: {},
    }),
  })),
  Sep12CustomerStatus: {
    NEEDS_INFO: "needs_info",
    PROCESSING: "processing",
    REJECTED: "rejected",
    ACCEPTED: "accepted",
  },
}));

const VALID_RIBS = [
  { country: "CM", alpha3: "CMR", rib: "30004300051234567890131" },
  { country: "GA", alpha3: "GAB", rib: "20002200029876543210124" },
  { country: "TD", alpha3: "TCD", rib: "10001100051234567890165" },
  { country: "CG", alpha3: "COG", rib: "40004400051234567890110" },
];

const ACCOUNT = Keypair.random().publicKey();

describe("SEP-6 CEMAC RIB validation (#2431)", () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use("/sep6", createSep6Router({ query: jest.fn() } as any));
  });

  describe("validateCemacRib", () => {
    it.each(VALID_RIBS)(
      "accepts a valid $country RIB using alpha-2 and alpha-3 codes",
      ({ country, alpha3, rib }) => {
        expect(validateCemacRib(rib, country).valid).toBe(true);
        expect(validateCemacRib(rib, alpha3).valid).toBe(true);
      },
    );

    it("accepts whitespace and common grouping separators", () => {
      expect(
        validateCemacRib("30004 30005 12345678901 31", "CM").valid,
      ).toBe(true);
      expect(
        validateCemacRib("30004-30005-12345678901-31", "CMR").valid,
      ).toBe(true);
    });

    it("rejects a bad checksum key", () => {
      const result = validateCemacRib("30004300051234567890199", "CM", "dest");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("dest");
      expect(result.error).toMatch(/checksum|key/i);
    });

    it("rejects malformed lengths and non-digit RIBs for CEMAC countries", () => {
      expect(validateCemacRib("3000430005123456789013", "CM").valid).toBe(false);
      expect(validateCemacRib("300043000512345678901310", "GAB").valid).toBe(
        false,
      );
      expect(validateCemacRib("ABCDEFGHIJKLMNOPQRSTUVW", "TD").valid).toBe(
        false,
      );
    });

    it("validates 23-digit values when no country is declared", () => {
      expect(validateCemacRib("30004300051234567890131").valid).toBe(true);
      expect(validateCemacRib("30004300051234567890199").valid).toBe(false);
    });

    it("does not enforce the CEMAC checksum for other countries or missing values", () => {
      expect(validateCemacRib("12345", "US").valid).toBe(true);
      expect(validateCemacRib("12345", "FR").valid).toBe(true);
      expect(validateCemacRib(undefined, "CM").valid).toBe(true);
      expect(validateCemacRib("", "CM").valid).toBe(true);
    });
  });

  describe("GET /sep6/withdraw", () => {
    it.each(VALID_RIBS)(
      "accepts a valid $country RIB in dest",
      async ({ country, rib }) => {
        const res = await request(app)
          .get("/sep6/withdraw")
          .query({
            asset_code: "XLM",
            type: "bank_account",
            dest: rib,
            dest_extra: "30004",
            account: ACCOUNT,
            country_code: country,
          });

        expect(res.status).toBe(200);
        expect(res.body.id).toBeDefined();
        expect(res.body.account).toBeDefined();
      },
    );

    it("rejects a RIB that fails the checksum before creating a transaction", async () => {
      const res = await request(app)
        .get("/sep6/withdraw")
        .query({
          asset_code: "XLM",
          type: "bank_account",
          dest: "30004300051234567890199",
          account: ACCOUNT,
          country_code: "CM",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_rib");
      expect(res.body.message).toContain("dest");
      expect(res.body.message).toMatch(/checksum|key/i);
      expect(res.body.details.field).toBe("dest");
      expect(res.body.details.country).toBe("CM");
    });

    it("rejects a malformed RIB for an alpha-3 CEMAC country", async () => {
      const res = await request(app)
        .get("/sep6/withdraw")
        .query({
          asset_code: "XLM",
          type: "bank_account",
          dest: "not-a-rib",
          account: ACCOUNT,
          country_code: "SEN",
        });

      // Senegal is not a CEMAC country, so it is intentionally left alone.
      expect(res.status).toBe(200);

      const cemacRes = await request(app)
        .get("/sep6/withdraw")
        .query({
          asset_code: "XLM",
          type: "bank_account",
          dest: "not-a-rib",
          account: ACCOUNT,
          country_code: "GAB",
        });

      expect(cemacRes.status).toBe(400);
      expect(cemacRes.body.details.country).toBe("GAB");
    });

    it("leaves short non-CEMAC bank account numbers unchanged", async () => {
      const res = await request(app)
        .get("/sep6/withdraw")
        .query({
          asset_code: "XLM",
          type: "bank_account",
          dest: "123456789",
          account: ACCOUNT,
          country_code: "US",
        });

      expect(res.status).toBe(200);
    });
  });

  describe("POST /sep6/withdraw", () => {
    it("accepts a valid RIB supplied in the request body", async () => {
      const res = await request(app)
        .post("/sep6/withdraw")
        .send({
          asset_code: "XLM",
          type: "bank_account",
          dest: "30004 30005 12345678901 31",
          account: ACCOUNT,
          country_code: "CMR",
        });

      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
    });

    it("rejects an invalid RIB supplied in the request body", async () => {
      const res = await request(app)
        .post("/sep6/withdraw")
        .send({
          asset_code: "XLM",
          type: "bank_account",
          dest: "30004300051234567890199",
          account: ACCOUNT,
          country_code: "CM",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_rib");
      expect(res.body.details.field).toBe("dest");
    });
  });
});
