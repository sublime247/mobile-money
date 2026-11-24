import express from "express";
import request from "supertest";
import crypto from "crypto";

jest.mock("../../services/mobilemoney/mobileMoneyService", () => ({
  MobileMoneyService: jest.fn().mockImplementation(() => ({
    sendPayout: jest.fn().mockResolvedValue({ success: true }),
  })),
}));

jest.mock("../../services/multisigCustodyLedgerService", () => ({
  multisigCustodyLedgerService: {
    getRequestById: jest.fn(),
    getSigners: jest.fn(),
    verifyWebhookSignature: jest.fn(),
    addSignature: jest.fn(),
    executeApprovedRequest: jest.fn(),
  },
}));

import { multisigCustodyLedgerService } from "../../services/multisigCustodyLedgerService";
import multisigCallbacksRouter from "../multisigCallbacks";

const mockService = multisigCustodyLedgerService as jest.Mocked<
  typeof multisigCustodyLedgerService
>;

const REQUEST_ID = "req-1";
const CONFIG_ID = "config-1";

const pendingRequest = {
  id: REQUEST_ID,
  config_id: CONFIG_ID,
  request_type: "withdrawal",
  account_id: "vault-1",
  amount_xaf: 100_000,
  destination: "+237600000000",
  metadata: { provider: "mtn" },
  status: "pending",
  required_signatures: 2,
  collected_signatures: 1,
  expires_at: new Date(Date.now() + 60_000),
  created_by: "admin-1",
};

const registeredSigner = {
  id: "signer-row-1",
  config_id: CONFIG_ID,
  signer_id: "signer-1",
  signer_name: "Signer One",
  public_key: "registered-public-key",
  weight: 1,
  is_active: true,
};

describe("multisigCallbacks route", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/multisig", multisigCallbacksRouter);
  });

  it("returns 404 when the request does not exist", async () => {
    mockService.getRequestById.mockResolvedValueOnce(null);

    const response = await request(app).post("/api/multisig/callback").send({
      requestId: "missing",
      signerId: "signer-1",
      signature: "deadbeef",
      payload: "test-payload",
    });

    expect(response.status).toBe(404);
    expect(mockService.verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it("rejects a signerId that is not registered for the request's config", async () => {
    mockService.getRequestById.mockResolvedValueOnce(pendingRequest as any);
    mockService.getSigners.mockResolvedValueOnce([registeredSigner] as any);

    const response = await request(app).post("/api/multisig/callback").send({
      requestId: REQUEST_ID,
      signerId: "someone-else",
      signature: "deadbeef",
      payload: "test-payload",
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Signer not authorized");
    expect(mockService.verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it("verifies the signature against the DB-registered public key, never a client-supplied one", async () => {
    mockService.getRequestById.mockResolvedValueOnce(pendingRequest as any);
    mockService.getSigners.mockResolvedValueOnce([registeredSigner] as any);
    mockService.verifyWebhookSignature.mockReturnValueOnce(true);
    mockService.addSignature.mockResolvedValueOnce({
      success: true,
      message: "Signature recorded",
      fullyApproved: false,
    });

    // An attacker submits their OWN keypair's public key alongside a
    // signature that is cryptographically valid for that keypair. Before
    // the fix, the route trusted this client-supplied key directly; now it
    // must be ignored in favor of the signer's registered key.
    const attackerKeys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const attackerPublicKeyPem = attackerKeys.publicKey
      .export({ type: "pkcs1", format: "pem" })
      .toString();
    const forgedSignature = crypto
      .sign("sha256", Buffer.from("test-payload"), attackerKeys.privateKey)
      .toString("hex");

    await request(app).post("/api/multisig/callback").send({
      requestId: REQUEST_ID,
      signerId: "signer-1",
      signature: forgedSignature,
      payload: "test-payload",
      publicKey: attackerPublicKeyPem, // must be ignored
    });

    expect(mockService.verifyWebhookSignature).toHaveBeenCalledWith(
      "test-payload",
      forgedSignature,
      "registered-public-key", // the registered key, NOT attackerPublicKeyPem
    );
  });

  it("rejects when the signature does not verify against the registered key", async () => {
    mockService.getRequestById.mockResolvedValueOnce(pendingRequest as any);
    mockService.getSigners.mockResolvedValueOnce([registeredSigner] as any);
    mockService.verifyWebhookSignature.mockReturnValueOnce(false);

    const response = await request(app).post("/api/multisig/callback").send({
      requestId: REQUEST_ID,
      signerId: "signer-1",
      signature: "bogus",
      payload: "test-payload",
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Invalid signature");
    expect(mockService.addSignature).not.toHaveBeenCalled();
  });

  it("executes the payout once the signature threshold is met", async () => {
    mockService.getRequestById.mockResolvedValueOnce(pendingRequest as any);
    mockService.getSigners.mockResolvedValueOnce([registeredSigner] as any);
    mockService.verifyWebhookSignature.mockReturnValueOnce(true);
    mockService.addSignature.mockResolvedValueOnce({
      success: true,
      message: "Request fully approved",
      fullyApproved: true,
    });
    mockService.executeApprovedRequest.mockResolvedValueOnce({
      success: true,
      message: "Request executed successfully",
    });

    const response = await request(app).post("/api/multisig/callback").send({
      requestId: REQUEST_ID,
      signerId: "signer-1",
      signature: "valid-signature",
      payload: "test-payload",
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("executed");
    expect(response.body.fullyApproved).toBe(true);
    expect(mockService.executeApprovedRequest).toHaveBeenCalledWith(
      REQUEST_ID,
      "system",
    );
  });

  describe("Extended Multi-Signature Auth Flow Verification Scenarios", () => {
    it("rejects callback with 400 when required payload fields are missing", async () => {
      const response = await request(app).post("/api/multisig/callback").send({
        requestId: REQUEST_ID,
        signerId: "signer-1",
        // missing signature and payload
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Missing required fields");
      expect(mockService.getRequestById).not.toHaveBeenCalled();
    });

    it("rejects an inactive signer even if they are in the configuration", async () => {
      const inactiveSigner = {
        ...registeredSigner,
        signer_id: "inactive-signer",
        is_active: false,
      };
      mockService.getRequestById.mockResolvedValueOnce(pendingRequest as any);
      mockService.getSigners.mockResolvedValueOnce([inactiveSigner] as any);

      const response = await request(app).post("/api/multisig/callback").send({
        requestId: REQUEST_ID,
        signerId: "inactive-signer",
        signature: "valid-sig-format",
        payload: "test-payload",
      });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Signer not authorized");
      expect(mockService.verifyWebhookSignature).not.toHaveBeenCalled();
    });

    it("handles partial approval where threshold is not yet met without executing payout", async () => {
      mockService.getRequestById.mockResolvedValueOnce(pendingRequest as any);
      mockService.getSigners.mockResolvedValueOnce([registeredSigner] as any);
      mockService.verifyWebhookSignature.mockReturnValueOnce(true);
      mockService.addSignature.mockResolvedValueOnce({
        success: true,
        message: "Signature added successfully. 1 of 2 required signatures collected.",
        fullyApproved: false,
      });

      const response = await request(app).post("/api/multisig/callback").send({
        requestId: REQUEST_ID,
        signerId: "signer-1",
        signature: "valid-sig",
        payload: "test-payload",
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.status).toBe("pending_signatures");
      expect(response.body.fullyApproved).toBe(false);
      expect(mockService.executeApprovedRequest).not.toHaveBeenCalled();
    });

    it("returns 400 when addSignature fails (e.g. duplicate signature from same signer)", async () => {
      mockService.getRequestById.mockResolvedValueOnce(pendingRequest as any);
      mockService.getSigners.mockResolvedValueOnce([registeredSigner] as any);
      mockService.verifyWebhookSignature.mockReturnValueOnce(true);
      mockService.addSignature.mockResolvedValueOnce({
        success: false,
        message: "Signer has already signed this request",
        fullyApproved: false,
      });

      const response = await request(app).post("/api/multisig/callback").send({
        requestId: REQUEST_ID,
        signerId: "signer-1",
        signature: "valid-sig",
        payload: "test-payload",
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Signer has already signed this request");
      expect(mockService.executeApprovedRequest).not.toHaveBeenCalled();
    });
  });
});
