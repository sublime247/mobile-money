import { HtlcService } from "../../src/services/stellar/htlcService";
import * as StellarSdk from "stellar-sdk";

jest.mock("../../src/config/stellar", () => ({
  getStellarServer: jest.fn().mockReturnValue({
    loadAccount: jest.fn().mockResolvedValue({
      sequenceNumber: () => "1",
      accountId: () => "GBSender...",
      sequence: "1",
    }),
  }),
  getNetworkPassphrase: jest.fn().mockReturnValue("Test SDF Network ; September 2015"),
}));

describe("HtlcService", () => {
  let htlcService: HtlcService;

  beforeEach(() => {
    htlcService = new HtlcService();
  });

  it("should build a lock transaction", async () => {
    const params = {
      senderAddress: "GBAF7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7", // Placeholder
      receiverAddress: "GBAF7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7",
      tokenAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2XJ",
      amount: "100",
      hashlock: "0".repeat(64),
      timelock: 2000,
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2XJ",
    };

    const tx = await htlcService.buildLockTx(params);
    expect(tx).toBeDefined();
    expect(tx.operations.length).toBe(1);
    expect(tx.operations[0].type).toBe("invokeHostFunction");
  });

  it("should build a claim transaction", async () => {
    const params = {
      claimerAddress: "GBAF7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7YV6T7",
      preimage: "0".repeat(64),
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2XJ",
    };

    const tx = await htlcService.buildClaimTx(params);
    expect(tx).toBeDefined();
    expect(tx.operations.length).toBe(1);
    expect(tx.operations[0].type).toBe("invokeHostFunction");
  });
});
