import * as StellarSdk from "@stellar/stellar-sdk";
import { Sep10Service } from "../sep10";

describe("SEP-10 Challenge Expiration Validation (#1942)", () => {
  const serverKeypair = StellarSdk.Keypair.random();
  const clientKeypair = StellarSdk.Keypair.random();

  const config = {
    signingKey: serverKeypair.secret(),
    webAuthDomain: "https://api.example.com",
    networkPassphrase: StellarSdk.Networks.TESTNET,
    jwtSecret: "test-jwt-secret",
    challengeExpiresIn: 300, // 5 minutes
    jwtExpiresIn: "1h",
    homeDomain: "api.example.com",
  };

  const service = new Sep10Service(config as any);

  beforeEach(() => {
    jest.spyOn(service, "fetchAccountSigners").mockResolvedValue({
      signers: [{ publicKey: clientKeypair.publicKey(), weight: 1 }],
      thresholds: { lowThreshold: 1, mediumThreshold: 1, highThreshold: 1 },
      masterWeight: 1,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("accepts a challenge transaction within valid timebounds", async () => {
    const challengeRes = await service.generateChallenge(clientKeypair.publicKey());
    const tx = StellarSdk.TransactionBuilder.fromXDR(
      challengeRes.transaction,
      StellarSdk.Networks.TESTNET,
    ) as StellarSdk.Transaction;

    tx.sign(clientKeypair);

    const tokenRes = await service.verifyChallenge(tx.toXDR());
    expect(tokenRes.token).toBeDefined();
  });

  it("rejects an expired challenge transaction with 'Transaction has expired'", async () => {
    const expiredService = new Sep10Service({
      ...config,
      challengeExpiresIn: -100, // Already expired in past
    } as any);

    jest.spyOn(expiredService, "fetchAccountSigners").mockResolvedValue({
      signers: [{ publicKey: clientKeypair.publicKey(), weight: 1 }],
      thresholds: { lowThreshold: 1, mediumThreshold: 1, highThreshold: 1 },
      masterWeight: 1,
    });

    const challengeRes = await expiredService.generateChallenge(clientKeypair.publicKey());
    const tx = StellarSdk.TransactionBuilder.fromXDR(
      challengeRes.transaction,
      StellarSdk.Networks.TESTNET,
    ) as StellarSdk.Transaction;

    tx.sign(clientKeypair);

    await expect(expiredService.verifyChallenge(tx.toXDR())).rejects.toThrow("Transaction has expired");
  });

  it("rejects a challenge transaction with future minTime ('Transaction is not yet valid')", async () => {
    const futureNow = Math.floor(Date.now() / 1000) + 3600;
    const sourceAccount = new StellarSdk.Account(clientKeypair.publicKey(), "-1");

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: StellarSdk.Networks.TESTNET,
      timebounds: {
        minTime: String(futureNow),
        maxTime: String(futureNow + 300),
      },
    })
      .addMemo(new StellarSdk.Memo(StellarSdk.MemoHash, Buffer.alloc(32)))
      .addOperation(
        StellarSdk.Operation.manageData({
          name: "api.example.com auth",
          value: Buffer.alloc(64),
          source: clientKeypair.publicKey(),
        }),
      )
      .addOperation(
        StellarSdk.Operation.manageData({
          name: "web_auth_domain",
          value: config.webAuthDomain,
          source: serverKeypair.publicKey(),
        }),
      )
      .build();

    tx.sign(serverKeypair);
    tx.sign(clientKeypair);

    await expect(service.verifyChallenge(tx.toXDR())).rejects.toThrow("Transaction is not yet valid");
  });
});
