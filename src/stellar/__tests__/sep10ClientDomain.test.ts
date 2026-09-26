import * as StellarSdk from "@stellar/stellar-sdk";
import { Sep10Service, fetchClientDomainSigningKey } from "../sep10";

describe("SEP-10 Client Domain Verification Against stellar.toml (#1946)", () => {
  const serverKeypair = StellarSdk.Keypair.random();
  const clientKeypair = StellarSdk.Keypair.random();
  const domainSigningKeypair = StellarSdk.Keypair.random();

  const config = {
    signingKey: serverKeypair.secret(),
    webAuthDomain: "https://api.example.com",
    networkPassphrase: StellarSdk.Networks.TESTNET,
    jwtSecret: "super-secret-jwt-key",
    challengeExpiresIn: 900,
    jwtExpiresIn: "1h",
    homeDomain: "api.example.com",
  };

  const service = new Sep10Service(config as any);

  beforeEach(() => {
    jest.spyOn(service, "fetchAccountSigners").mockResolvedValue({
      signers: [
        { publicKey: clientKeypair.publicKey(), weight: 1 },
        { publicKey: domainSigningKeypair.publicKey(), weight: 1 },
      ],
      thresholds: { lowThreshold: 1, mediumThreshold: 1, highThreshold: 1 },
      masterWeight: 1,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("fetches SIGNING_KEY from client domain stellar.toml", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        VERSION = "2.0.0"
        SIGNING_KEY = "${domainSigningKeypair.publicKey()}"
      `,
    });

    const key = await fetchClientDomainSigningKey("wallet.example.com", mockFetch as any);
    expect(key).toBe(domainSigningKeypair.publicKey());
    expect(mockFetch).toHaveBeenCalledWith(
      "https://wallet.example.com/.well-known/stellar.toml",
      expect.anything(),
    );
  });

  it("fails challenge generation if client_domain stellar.toml cannot be resolved", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    await expect(
      service.generateChallenge(clientKeypair.publicKey(), undefined, "unknown.example.com", mockFetch as any),
    ).rejects.toThrow("Client domain verification failed");
  });

  it("generates and verifies challenge when client_domain is signed by TOML signing key", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        SIGNING_KEY = "${domainSigningKeypair.publicKey()}"
      `,
    });

    const challengeRes = await service.generateChallenge(
      clientKeypair.publicKey(),
      undefined,
      "client.example.com",
      mockFetch as any,
    );

    const tx = StellarSdk.TransactionBuilder.fromXDR(
      challengeRes.transaction,
      StellarSdk.Networks.TESTNET,
    ) as StellarSdk.Transaction;

    // Client signs with master key + domain keypair
    tx.sign(clientKeypair);
    tx.sign(domainSigningKeypair);

    const tokenRes = await service.verifyChallenge(tx.toXDR(), clientKeypair.publicKey(), mockFetch as any);
    expect(tokenRes.token).toBeDefined();
  });

  it("rejects verification if transaction is not signed by client domain SIGNING_KEY", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        SIGNING_KEY = "${domainSigningKeypair.publicKey()}"
      `,
    });

    const challengeRes = await service.generateChallenge(
      clientKeypair.publicKey(),
      undefined,
      "client.example.com",
      mockFetch as any,
    );

    const tx = StellarSdk.TransactionBuilder.fromXDR(
      challengeRes.transaction,
      StellarSdk.Networks.TESTNET,
    ) as StellarSdk.Transaction;

    // Client signs with master key ONLY (missing domain keypair signature)
    tx.sign(clientKeypair);

    await expect(
      service.verifyChallenge(tx.toXDR(), clientKeypair.publicKey(), mockFetch as any),
    ).rejects.toThrow("Transaction is not signed by client domain SIGNING_KEY");
  });
});
