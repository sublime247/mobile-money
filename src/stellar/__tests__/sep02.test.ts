import request from "supertest";
import express, { Express } from "express";
import { Pool } from "pg";
import crypto from "crypto";
import {
  createFederationRouter,
  FederationService,
  buildStellarToml,
} from "../sep02";

// ============================================================================
// Helpers (mirror the private helpers in sep02.ts)
// ============================================================================

function sha256(value: string): string {
  return crypto
    .createHash("sha256")
    .update(value.toLowerCase().trim())
    .digest("hex");
}

function mockQueryResult(rows: object[]) {
  return {
    rows,
    command: "",
    oid: 0,
    rowCount: rows.length,
    fields: [],
  };
}

// ============================================================================
// Test setup
// ============================================================================

describe("SEP-02 Federation Server", () => {
  let app: Express;
  let mockDb: jest.Mocked<Pool>;

  const DOMAIN = "mobilemoney.com";
  const ACCOUNT_ID =
    "GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678901234567890";

  beforeEach(() => {
    process.env.STELLAR_FEDERATION_DOMAIN = DOMAIN;

    mockDb = { query: jest.fn() } as unknown as jest.Mocked<Pool>;

    app = express();
    app.use(express.json());
    app.use("/federation", createFederationRouter(mockDb));
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.STELLAR_FEDERATION_DOMAIN;
  });

  // ==========================================================================
  // Parameter validation
  // ==========================================================================

  describe("Parameter validation", () => {
    it("returns 400 when q is missing", async () => {
      const res = await request(app).get("/federation").query({ type: "name" });
      expect(res.status).toBe(400);
      expect(res.body.detail).toMatch(/q is required/i);
    });

    it("returns 400 when type is missing", async () => {
      const res = await request(app)
        .get("/federation")
        .query({ q: `alice*${DOMAIN}` });
      expect(res.status).toBe(400);
    });

    it("returns 400 when type is invalid", async () => {
      const res = await request(app)
        .get("/federation")
        .query({ q: `alice*${DOMAIN}`, type: "bad" });
      expect(res.status).toBe(400);
    });

    it("returns 501 for txid type", async () => {
      const res = await request(app)
        .get("/federation")
        .query({ q: "sometxid", type: "txid" });
      expect(res.status).toBe(501);
    });

    it("returns 501 for forward type", async () => {
      const res = await request(app)
        .get("/federation")
        .query({ q: "somequery", type: "forward" });
      expect(res.status).toBe(501);
    });
  });

  // ==========================================================================
  // type=name lookups
  // ==========================================================================

  describe("GET /federation?type=name", () => {
    it("resolves federation address by username", async () => {
      mockDb.query.mockResolvedValueOnce(
        mockQueryResult([
          { id: "user-1", stellar_address: ACCOUNT_ID, username: "alice" },
        ]),
      );

      const res = await request(app)
        .get("/federation")
        .query({ q: `alice*${DOMAIN}`, type: "name" });

      expect(res.status).toBe(200);
      expect(res.body.stellar_address).toBe(`alice*${DOMAIN}`);
      expect(res.body.account_id).toBe(ACCOUNT_ID);
    });

    it("resolves by phone hash when username not found", async () => {
      // username lookup: no rows
      mockDb.query
        .mockResolvedValueOnce(mockQueryResult([]))
        // phone hash lookup: found
        .mockResolvedValueOnce(
          mockQueryResult([
            {
              id: "user-2",
              stellar_address: ACCOUNT_ID,
              username: null,
              phone_hash: sha256("+254712345678"),
            },
          ]),
        );

      const res = await request(app)
        .get("/federation")
        .query({ q: `+254712345678*${DOMAIN}`, type: "name" });

      expect(res.status).toBe(200);
      expect(res.body.account_id).toBe(ACCOUNT_ID);
    });

    it("resolves by email hash when username and phone not found", async () => {
      mockDb.query
        .mockResolvedValueOnce(mockQueryResult([])) // username miss
        .mockResolvedValueOnce(mockQueryResult([])) // phone miss
        .mockResolvedValueOnce(
          mockQueryResult([
            {
              id: "user-3",
              stellar_address: ACCOUNT_ID,
              username: "bob",
              email_hash: sha256("bob@example.com"),
            },
          ]),
        );

      const res = await request(app)
        .get("/federation")
        .query({ q: `bob@example.com*${DOMAIN}`, type: "name" });

      expect(res.status).toBe(200);
      expect(res.body.stellar_address).toBe(`bob*${DOMAIN}`);
      expect(res.body.account_id).toBe(ACCOUNT_ID);
    });

    it("returns 404 when no user matches", async () => {
      mockDb.query
        .mockResolvedValueOnce(mockQueryResult([]))
        .mockResolvedValueOnce(mockQueryResult([]))
        .mockResolvedValueOnce(mockQueryResult([]));

      const res = await request(app)
        .get("/federation")
        .query({ q: `unknown*${DOMAIN}`, type: "name" });

      expect(res.status).toBe(404);
      expect(res.body.detail).toMatch(/not found/i);
    });

    it("returns 404 for a different domain", async () => {
      const res = await request(app)
        .get("/federation")
        .query({ q: `alice*otherdomain.com`, type: "name" });

      expect(res.status).toBe(404);
    });

    it("returns 400 for malformed federation address", async () => {
      // Missing asterisk → parseFederationAddress returns null
      const res = await request(app)
        .get("/federation")
        .query({ q: `alicemobilemoney.com`, type: "name" });

      // parseFederationAddress returns null → lookupByName returns null → 404
      expect(res.status).toBe(404);
    });
  });

  // ==========================================================================
  // type=id (reverse lookup)
  // ==========================================================================

  describe("GET /federation?type=id", () => {
    it("resolves stellar address to federation record", async () => {
      mockDb.query.mockResolvedValueOnce(
        mockQueryResult([
          { stellar_address: ACCOUNT_ID, username: "carol", phone_hash: null },
        ]),
      );

      const res = await request(app)
        .get("/federation")
        .query({ q: ACCOUNT_ID, type: "id" });

      expect(res.status).toBe(200);
      expect(res.body.stellar_address).toBe(`carol*${DOMAIN}`);
      expect(res.body.account_id).toBe(ACCOUNT_ID);
    });

    it("uses account_id as localPart when username is null", async () => {
      mockDb.query.mockResolvedValueOnce(
        mockQueryResult([
          { stellar_address: ACCOUNT_ID, username: null, phone_hash: null },
        ]),
      );

      const res = await request(app)
        .get("/federation")
        .query({ q: ACCOUNT_ID, type: "id" });

      expect(res.status).toBe(200);
      expect(res.body.stellar_address).toBe(`${ACCOUNT_ID}*${DOMAIN}`);
    });

    it("returns 404 when stellar address is not registered", async () => {
      mockDb.query.mockResolvedValueOnce(mockQueryResult([]));

      const res = await request(app)
        .get("/federation")
        .query({ q: ACCOUNT_ID, type: "id" });

      expect(res.status).toBe(404);
    });
  });

  // ==========================================================================
  // Response structure conformance (SEP-02)
  // ==========================================================================

  describe("SEP-02 response structure", () => {
    it("always includes stellar_address and account_id", async () => {
      mockDb.query.mockResolvedValueOnce(
        mockQueryResult([
          { id: "user-1", stellar_address: ACCOUNT_ID, username: "dave" },
        ]),
      );

      const res = await request(app)
        .get("/federation")
        .query({ q: `dave*${DOMAIN}`, type: "name" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("stellar_address");
      expect(res.body).toHaveProperty("account_id");
      // memo fields are optional; when absent they must not be present
      expect(res.body).not.toHaveProperty("memo_type");
      expect(res.body).not.toHaveProperty("memo");
    });

    it("stellar_address in response matches query domain", async () => {
      mockDb.query.mockResolvedValueOnce(
        mockQueryResult([
          { id: "user-1", stellar_address: ACCOUNT_ID, username: "dave" },
        ]),
      );

      const res = await request(app)
        .get("/federation")
        .query({ q: `dave*${DOMAIN}`, type: "name" });

      expect(res.body.stellar_address).toMatch(new RegExp(`\\*${DOMAIN}$`));
    });
  });

  // ==========================================================================
  // FederationService unit tests
  // ==========================================================================

  describe("FederationService", () => {
    let service: FederationService;

    beforeEach(() => {
      service = new FederationService(mockDb);
    });

    it("lookupByName returns null for unknown domain", async () => {
      const result = await service.lookupByName("alice*unknown.io");
      expect(result).toBeNull();
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it("lookupByName returns null when address has no asterisk", async () => {
      const result = await service.lookupByName("invaliddomain.com");
      expect(result).toBeNull();
    });

    it("lookupById queries by stellar_address", async () => {
      mockDb.query.mockResolvedValueOnce(
        mockQueryResult([
          { stellar_address: ACCOUNT_ID, username: "eve", phone_hash: null },
        ]),
      );

      const result = await service.lookupById(ACCOUNT_ID);
      expect(result).not.toBeNull();
      expect(result!.account_id).toBe(ACCOUNT_ID);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("stellar_address = $1"),
        [ACCOUNT_ID],
      );
    });
  });

  // ==========================================================================
  // stellar.toml helper
  // ==========================================================================

  describe("buildStellarToml", () => {
    it("includes FEDERATION_SERVER line", () => {
      const toml = buildStellarToml();
      expect(toml).toMatch(/FEDERATION_SERVER=/);
    });

    it("includes NETWORK_PASSPHRASE line", () => {
      const toml = buildStellarToml();
      expect(toml).toMatch(/NETWORK_PASSPHRASE=/);
    });

    it("uses testnet passphrase when STELLAR_NETWORK=testnet", () => {
      process.env.STELLAR_NETWORK = "testnet";
      const toml = buildStellarToml();
      expect(toml).toMatch(/Test SDF Network/);
    });

    it("uses mainnet passphrase when STELLAR_NETWORK=mainnet", () => {
      process.env.STELLAR_NETWORK = "mainnet";
      const toml = buildStellarToml();
      expect(toml).toMatch(/Public Global Stellar Network/);
      delete process.env.STELLAR_NETWORK;
    });
  });
});
