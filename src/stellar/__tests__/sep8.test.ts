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
  Transaction,
} from "@stellar/stellar-sdk";
import {
  createSep8Router,
  enforceSep8Approval,
  Sep8ActionRequiredError,
  Sep8ApprovalError,
  Sep8ClientError,
  Sep8ConfigurationError,
  Sep8PendingError,
  Sep8RejectedError,
  Sep8ApprovalResult,
} from "../sep8";
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
      const {
        Transaction,
        Networks: SDKNetworks,
      } = require("@stellar/stellar-sdk");

      const res = await request(app)
        .post("/sep8/tx_approve")
        .send({ tx: buildTestTx() });

      expect(res.body.status).toBe("success");

      const signedTx = new Transaction(res.body.tx, SDKNetworks.TESTNET);
      const signers = signedTx.signatures.map((s: any) =>
        Keypair.fromPublicKey(SERVER_KEYPAIR.publicKey()).verify(
          Buffer.from(signedTx.hash()),
          s.signature,
        ),
      );
      expect(signers.some(Boolean)).toBe(true);
    });
  });
});

// --------------------------------------------------------------------------
// Client-side approval pipeline (issue #2432)
// --------------------------------------------------------------------------

function buildNativeTx(): string {
  const account = new Account(CLIENT_KEYPAIR.publicKey(), "12345");
  return new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: DEST_KEYPAIR.publicKey(),
        asset: Asset.native(),
        amount: "10",
      }),
    )
    .setTimeout(30)
    .build()
    .toEnvelope()
    .toXDR("base64");
}

describe("SEP-08 client-side approval pipeline (#2432)", () => {
  const CLIENT_OPTIONS = {
    networkPassphrase: Networks.TESTNET,
    approvalServerUrl: "https://approval.example.com/tx_approve",
  };

  let horizon: {
    loadAsset: jest.Mock;
    loadAccount: jest.Mock;
  };
  let approval: { approve: jest.Mock };
  let options: typeof CLIENT_OPTIONS & {
    horizon: typeof horizon;
    approval: typeof approval;
  };

  beforeEach(() => {
    horizon = {
      loadAsset: jest
        .fn()
        .mockResolvedValue({ flags: { auth_required: true } }),
      loadAccount: jest.fn().mockResolvedValue({ flags: {} }),
    };
    approval = { approve: jest.fn() };
    options = { ...CLIENT_OPTIONS, horizon, approval };
    delete process.env.SEP8_APPROVAL_SERVER_URL;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("is a no-op for transactions without non-native assets", async () => {
    const envelope = buildNativeTx();

    const result = await enforceSep8Approval(envelope, options);

    expect(result).toEqual({
      regulated: false,
      status: null,
      envelope,
    });
    expect(horizon.loadAsset).not.toHaveBeenCalled();
    expect(approval.approve).not.toHaveBeenCalled();
  });

  it("is a no-op when Horizon reports no authorization flags", async () => {
    horizon.loadAsset.mockResolvedValue({
      flags: { auth_required: false, auth_revocable: false },
    });
    horizon.loadAccount.mockResolvedValue({ flags: {} });
    const envelope = buildTestTx();

    const result = await enforceSep8Approval(envelope, options);

    expect(result.regulated).toBe(false);
    expect(result.envelope).toBe(envelope);
    expect(approval.approve).not.toHaveBeenCalled();
  });

  it("treats an issuer account with auth_revocable as regulated", async () => {
    horizon.loadAsset.mockResolvedValue({ flags: {} });
    horizon.loadAccount.mockResolvedValue({
      flags: { auth_revocable: true },
    });
    approval.approve.mockResolvedValue({
      status: "success",
      tx: buildTestTx(),
      message: "approved",
    });

    await enforceSep8Approval(buildTestTx(), options);

    expect(horizon.loadAccount).toHaveBeenCalledWith(TEST_ASSET.issuer);
    expect(approval.approve).toHaveBeenCalledTimes(1);
  });

  it("approved: returns the signed XDR from the approval server", async () => {
    const envelope = buildTestTx();
    approval.approve.mockResolvedValue({
      status: "success",
      tx: envelope,
      message: "approved",
    });

    const result: Sep8ApprovalResult = await enforceSep8Approval(
      envelope,
      options,
    );

    expect(result.regulated).toBe(true);
    expect(result.status).toBe("success");
    expect(result.envelope).toBe(envelope);
    expect(result.assetCode).toBe(TEST_ASSET.code);
    expect(approval.approve).toHaveBeenCalledWith(envelope);
  });

  it("revised: replaces the transaction with the returned XDR", async () => {
    const revisedDestination = Keypair.random().publicKey();
    const revisedXdr = buildTestTx({ destination: revisedDestination });
    approval.approve.mockResolvedValue({
      status: "revised",
      tx: revisedXdr,
      message: "amount adjusted",
    });

    const result = await enforceSep8Approval(buildTestTx(), options);

    expect(result.status).toBe("revised");
    expect(result.envelope).toBe(revisedXdr);
    const submitted = TransactionBuilder.fromXDR(
      result.envelope,
      Networks.TESTNET,
    ) as Transaction;
    expect((submitted.operations[0] as any).destination).toBe(
      revisedDestination,
    );
  });

  it("rejected: throws a typed error with the server reason", async () => {
    approval.approve.mockResolvedValue({
      status: "rejected",
      error: "account is sanctioned",
    });

    const promise = enforceSep8Approval(buildTestTx(), options);

    await expect(promise).rejects.toBeInstanceOf(Sep8RejectedError);
    await expect(promise).rejects.toMatchObject({
      name: "Sep8RejectedError",
      status: "rejected",
      message: "account is sanctioned",
    });
  });

  it("action_required: throws a typed error carrying the KYC action", async () => {
    approval.approve.mockResolvedValue({
      status: "action_required",
      message: "Complete KYC",
      action_url: "https://kyc.example.com/start",
      action_method: "GET",
      action_fields: ["id_number"],
    });

    await expect(enforceSep8Approval(buildTestTx(), options)).rejects.toMatchObject({
      name: "Sep8ActionRequiredError",
      status: "action_required",
      actionUrl: "https://kyc.example.com/start",
      actionFields: ["id_number"],
    });
    await expect(
      enforceSep8Approval(buildTestTx(), options),
    ).rejects.toBeInstanceOf(Sep8ActionRequiredError);
  });

  it("pending: throws a typed error with the retry timeout", async () => {
    approval.approve.mockResolvedValue({
      status: "pending",
      timeout: 120,
      message: "KYC under review",
    });

    await expect(enforceSep8Approval(buildTestTx(), options)).rejects.toMatchObject({
      name: "Sep8PendingError",
      status: "pending",
      timeout: 120,
    });
    await expect(
      enforceSep8Approval(buildTestTx(), options),
    ).rejects.toBeInstanceOf(Sep8PendingError);
  });

  it("rejects malformed XDR returned by the approval server", async () => {
    approval.approve.mockResolvedValue({
      status: "revised",
      tx: "not-valid-xdr",
      message: "revised",
    });

    await expect(
      enforceSep8Approval(buildTestTx(), options),
    ).rejects.toBeInstanceOf(Sep8ApprovalError);
  });

  it("fails closed when a regulated asset has no configured approval server", async () => {
    await expect(
      enforceSep8Approval(buildTestTx(), {
        networkPassphrase: Networks.TESTNET,
        horizon,
      }),
    ).rejects.toBeInstanceOf(Sep8ConfigurationError);
    expect(approval.approve).not.toHaveBeenCalled();
  });

  it("wraps Horizon lookup failures in a typed inspection error", async () => {
    horizon.loadAsset.mockRejectedValue(new Error("Horizon down"));

    await expect(
      enforceSep8Approval(buildTestTx(), options),
    ).rejects.toMatchObject({
      name: "Sep8InspectionError",
      message: expect.stringContaining("Horizon down"),
    });
  });

  it("posts a form-encoded tx to the injected fetch implementation", async () => {
    const envelope = buildTestTx();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "success",
        tx: envelope,
        message: "approved",
      }),
    });

    const result = await enforceSep8Approval(envelope, {
      networkPassphrase: Networks.TESTNET,
      horizon,
      approvalServerUrl: CLIENT_OPTIONS.approvalServerUrl,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result.status).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CLIENT_OPTIONS.approvalServerUrl);
    expect(init.method).toBe("POST");
    expect(init.body).toContain("tx=");
    expect(decodeURIComponent(init.body.split("tx=")[1])).toBe(envelope);
  });

  it("surfaces approval server HTTP failures as typed errors", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    await expect(
      enforceSep8Approval(buildTestTx(), {
        networkPassphrase: Networks.TESTNET,
        horizon,
        approvalServerUrl: CLIENT_OPTIONS.approvalServerUrl,
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(Sep8ApprovalError);
  });

  it("wraps transport failures in a typed client error", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("network offline"));

    await expect(
      enforceSep8Approval(buildTestTx(), {
        networkPassphrase: Networks.TESTNET,
        horizon,
        approvalServerUrl: CLIENT_OPTIONS.approvalServerUrl,
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(Sep8ClientError);
  });
});
