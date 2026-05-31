import { AssetIssuanceService } from "../issuanceService";
import * as StellarSdk from "stellar-sdk";
import axios from "axios";

jest.mock("stellar-sdk");
jest.mock("axios");
jest.mock("../../utils/logger");
jest.mock("../../utils/encryption", () => ({
  encrypt: jest.fn((s) => `encrypted_${s}`),
}));

describe("AssetIssuanceService", () => {
  let service: AssetIssuanceService;
  let mockServer: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServer = {
      loadAccount: jest.fn().mockResolvedValue({
        sequenceNumber: "1",
        incrementSequenceNumber: jest.fn(),
      }),
      submitTransaction: jest.fn().mockResolvedValue({ hash: "123" }),
    };
    (StellarSdk as any).Horizon = {
      Server: jest.fn().mockReturnValue(mockServer),
    };
    (StellarSdk as any).Asset = jest
      .fn()
      .mockImplementation((code, issuer) => ({
        getCode: () => code,
        getIssuer: () => issuer,
        isNative: () => false,
      }));
    (StellarSdk as any).Keypair = {
      random: jest.fn().mockReturnValue({
        publicKey: () => "GBC...",
        secret: () => "SBC...",
      }),
    };
    (StellarSdk as any).Operation = {
      changeTrust: jest.fn().mockReturnValue({}),
      payment: jest.fn().mockReturnValue({}),
    };
    (StellarSdk as any).TransactionBuilder = jest
      .fn()
      .mockImplementation(() => ({
        addOperation: jest.fn().mockReturnThis(),
        setTimeout: jest.fn().mockReturnThis(),
        build: jest.fn().mockReturnValue({ sign: jest.fn() }),
      }));
    (StellarSdk as any).BASE_FEE = "100";

    service = new AssetIssuanceService();
    process.env.STELLAR_NETWORK = "testnet";
  });

  it("should setup an anchored asset successfully", async () => {
    (axios.get as jest.Mock).mockResolvedValue({ status: 200 });

    const result = await service.setupAnchoredAsset("USDX", "1000000");

    expect(result.assetCode).toBe("USDX");
    expect(result.issuerPublicKey).toBeDefined();
    expect(result.issuerSecretKeyEncrypted).toContain("encrypted_SBC");
    expect(axios.get).toHaveBeenCalledTimes(2); // Two accounts funded
    expect(mockServer.submitTransaction).toHaveBeenCalledTimes(2); // Trustline + Payment
  });

  it("should fail on mainnet without funding source", async () => {
    process.env.STELLAR_NETWORK = "mainnet";
    await expect(service.setupAnchoredAsset("USDX", "1000000")).rejects.toThrow(
      "Mainnet issuance automation requires a funding source account",
    );
  });
});
