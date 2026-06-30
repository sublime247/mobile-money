import request from "supertest";
import express, { Express } from "express";
import { Pool } from "pg";
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Asset,
  Account,
} from "stellar-sdk";
import { createSep8Router } from "../sep8";
import { Sep12Service, Sep12CustomerStatus } from "../sep12";
import {
  sanctionService,
  SanctionScreeningError,
} from "../../services/sanctionService";

jest.mock("../sep12");
jest.mock("../../services/sanctionService", () => ({
  sanctionService: { checkPartiesByAddress: jest.fn() },
  SanctionScreeningError: class SanctionScreeningError extends Error {
    constructor(...args: any[]) {
      super("Sanctioned");
      this.name = "SanctionScreeningError";
    }
  },
}));
jest.mock("../../config/stellar", () => ({
  getNetworkPassphrase: () => Networks.TESTNET,
}));

const SERVER_KEYPAIR = Keypair.random();
const CLIENT_KEYPAIR = Keypair.random();
const DEST_KEYPAIR = Keypair.random();

const TEST_ASSET = new Asset("USDC", Keypair.random().publicKey());

function buildTestTx(
  options: {
    sourceKeypair?: Keypair;
    includePayment?: boolean;
    destination?: string;
  } = {},
): string {
  const sourceKeypair = options.sourceKeypair ?? CLIENT_KEYPAIR;
  const account = new Account(sourceKeypair.publicKey(), "12345");
  const builder = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(30);

  if (options.includePayment !== false) {
    builder.addOperation(
      Operation.payment({
        destination: options.destination ?? DEST_KEYPAIR.publicKey(),
        asset: TEST_ASSET,
        amount: "10",
      }),
    );
  } else {
    // A change_trust op — non-payment operation
    builder.addOperation(Operation.changeTrust({ asset: TEST_ASSET }));
  }

  return builder.build().toEnvelope().toXDR("base64");
}

describe("SEP-08 Regulated Asset Approval", () => {
  let app: Express;
  let mockDb: jest.Mocked<Pool>;
  let mockSep12Service: jest.Mocked<Sep12Service>;

  beforeEach(() => {
    process.env.STELLAR_SIGNING_KEY = SERVER_KEYPAIR.secret();

    mockDb = { query: jest.fn() } as any;

    mockSep12Service = {
      getCustomer: jest.fn(),
    } as any;
    (Sep12Service as jest.MockedClass<typeof Sep12Service>).mockImplementation(
      () => mockSep12Service,
    );

    (sanctionService.checkPartiesByAddress as jest.Mock).mockResolvedValue(
      undefined,
    );

    app = express();
    app.use(express.json());
    app.use("/sep8", createSep8Router(mockDb));
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.STELLAR_SIGNING_KEY;
  });

  // --------------------------------------------------------------------------
  // Request validation
  // --------------------------------------------------------------------------

  describe("POST /tx_approve - request validation", () => {
    it("rejects when tx parameter is missing", async () => {
      const res = await request(app).post("/sep8/tx_approve").send({});
      expect(res.status).toBe(400);
      expect(res.body.status).toBe("rejected");
      expect(res.body.error).toMatch(/tx/i);
    });

    it("rejects when tx is not valid XDR", async () => {
      const res = await request(app)
        .post("/sep8/tx_approve")
        .send({ tx: "not-valid-xdr" });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe("rejected");
      expect(res.body.error).toMatch(/parse/i);
    });
  });

  // --------------------------------------------------------------------------
  // KYC gating
  // --------------------------------------------------------------------------

  describe("POST /tx_approve - KYC checks", () => {
    it("returns action_required when customer needs KYC info", async () => {
      mockSep12Service.getCustomer.mockResolvedValue({
        id: "cust-1",
        status: Sep12CustomerStatus.NEEDS_INFO,
        fields: {},
      } as any);

      const res = await request(app)
        .post("/sep8/tx_approve")
        .send({ tx: buildTestTx() });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("action_required");
      expect(res.body.action_url).toBeDefined();
      expect(Array.isArray(res.body.action_fields)).toBe(true);
    });

    it("returns action_required when customer is rejected", async () => {
      mockSep12Service.getCustomer.mockResolvedValue({
        id: "cust-2",
        status: Sep12CustomerStatus.REJECTED,
        fields: {},
      } as any);

      const res = await request(app)
        .post("/sep8/tx_approve")
        .send({ tx: buildTestTx() });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("action_required");
    });

    it("returns pending when KYC is still processing", async () => {
      mockSep12Service.getCustomer.mockResolvedValue({
        id: "cust-3",
        status: Sep12CustomerStatus.PROCESSING,
        fields: {},
      } as any);

      const res = await request(app)
        .post("/sep8/tx_approve")
        .send({ tx: buildTestTx() });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pending");
      expect(typeof res.body.timeout).toBe("number");
    });
  });

  // --------------------------------------------------------------------------
  // Sanctions gating
  // --------------------------------------------------------------------------

  describe("POST /tx_approve - sanctions checks", () => {
    beforeEach(() => {
      mockSep12Service.getCustomer.mockResolvedValue({
        id: "cust-ok",
        status: Sep12CustomerStatus.ACCEPTED,
        fields: {},
      } as any);
    });

    it("rejects when source account is sanctioned", async () => {
      (sanctionService.checkPartiesByAddress as jest.Mock).mockRejectedValue(
        new SanctionScreeningError(),
      );

      const res = await request(app)
        .post("/sep8/tx_approve")
        .send({ tx: buildTestTx() });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("rejected");
      expect(res.body.error).toMatch(/sanctions/i);
    });

    it("screens payment destination accounts", async () => {
      const customDest = Keypair.random().publicKey();
      await request(app)
        .post("/sep8/tx_approve")
        .send({ tx: buildTestTx({ destination: customDest }) });

      expect(sanctionService.checkPartiesByAddress).toHaveBeenCalledWith(
        CLIENT_KEYPAIR.publicKey(),
        customDest,
      );
    });

    it("screens source when transaction has no payment operations", async () => {
      await request(app)
        .post("/sep8/tx_approve")
        .send({ tx: buildTestTx({ includePayment: false }) });

      expect(sanctionService.checkPartiesByAddress).toHaveBeenCalledWith(
        CLIENT_KEYPAIR.publicKey(),
        CLIENT_KEYPAIR.publicKey(),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Approval
  // --------------------------------------------------------------------------

  describe("POST /tx_approve - approval", () => {
    beforeEach(() => {
      mockSep12Service.getCustomer.mockResolvedValue({
        id: "cust-ok",
        status: Sep12CustomerStatus.ACCEPTED,
        fields: {},
      } as any);
    });

    it("returns success with a signed transaction envelope", async () => {
      const res = await request(app)
        .post("/sep8/tx_approve")
        .send({ tx: buildTestTx() });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(typeof res.body.tx).toBe("string");
      expect(res.body.tx.length).toBeGreaterThan(0);
      expect(res.body.message).toBeDefined();
    });

    it("returned XDR carries the bridge's signature", async () => {
      const { Transaction, Networks: SDKNetworks } = require("stellar-sdk");

      const res = await request(app)
        .post("/sep8/tx_approve")
        .send({ tx: buildTestTx() });

      expect(res.body.status).toBe("success");

      const signedTx = new Transaction(res.body.tx, SDKNetworks.TESTNET);
      const signers = signedTx.signatures.map((s: any) =>
        Keypair.fromPublicKey(SERVER_KEYPAIR.publicKey()).verify(
          signedTx.hash(),
          s.signature(),
        ),
      );
      expect(signers.some(Boolean)).toBe(true);
    });
  });
});
