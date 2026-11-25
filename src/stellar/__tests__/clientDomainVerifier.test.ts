import * as StellarSdk from "@stellar/stellar-sdk";
import {
  parseStellarTomlAccounts,
  parseStellarTomlSigningKey,
  parseStellarToml,
  verifyClientDomain,
  assertClientDomainAuthorized,
  lookupClientDomainDnsTxt,
  clearClientDomainVerifierCache,
} from "../clientDomainVerifier";
import { Sep10Service, clearClientDomainCache } from "../sep10";

describe("SEP-10 Client Domain Authorization Verifier (#2562)", () => {
  const clientKeypair = StellarSdk.Keypair.random();
  const domainSigningKeypair = StellarSdk.Keypair.random();
  const authorizedAccountKeypair = StellarSdk.Keypair.random();
  const unauthorizedKeypair = StellarSdk.Keypair.random();

  const DOMAIN = "wallet.example.com";

  beforeEach(() => {
    clearClientDomainVerifierCache();
    clearClientDomainCache();
    jest.clearAllMocks();
  });

  describe("parseStellarTomlAccounts and parseStellarToml", () => {
    it("parses single-line ACCOUNTS array", () => {
      const toml = `
        VERSION = "2.0.0"
        SIGNING_KEY = "${domainSigningKeypair.publicKey()}"
        ACCOUNTS = ["${clientKeypair.publicKey()}", "${authorizedAccountKeypair.publicKey()}"]
      `;
      const accounts = parseStellarTomlAccounts(toml);
      expect(accounts).toEqual([
        clientKeypair.publicKey(),
        authorizedAccountKeypair.publicKey(),
      ]);
    });

    it("parses multi-line ACCOUNTS array", () => {
      const toml = `
        VERSION = "2.0.0"
        SIGNING_KEY = "${domainSigningKeypair.publicKey()}"
        ACCOUNTS = [
          "${clientKeypair.publicKey()}",
          "${authorizedAccountKeypair.publicKey()}"
        ]
      `;
      const parsed = parseStellarToml(toml);
      expect(parsed.signingKey).toBe(domainSigningKeypair.publicKey());
      expect(parsed.accounts).toContain(clientKeypair.publicKey());
      expect(parsed.accounts).toContain(authorizedAccountKeypair.publicKey());
    });

    it("ignores non-ed25519 accounts", () => {
      const toml = `
        ACCOUNTS = ["invalid-key", "12345", "${clientKeypair.publicKey()}"]
      `;
      const accounts = parseStellarTomlAccounts(toml);
      expect(accounts).toEqual([clientKeypair.publicKey()]);
    });
  });

  describe("verifyClientDomain via stellar.toml", () => {
    it("authorizes client public key matching SIGNING_KEY", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => `
          VERSION = "2.0.0"
          SIGNING_KEY = "${domainSigningKeypair.publicKey()}"
        `,
      });

      const result = await verifyClientDomain(
        DOMAIN,
        domainSigningKeypair.publicKey(),
        { fetchFn: mockFetch as any },
      );

      expect(result.authorized).toBe(true);
      expect(result.source).toBe("stellar_toml");
      expect(result.signingKey).toBe(domainSigningKeypair.publicKey());
      expect(mockFetch).toHaveBeenCalledWith(
        `https://${DOMAIN}/.well-known/stellar.toml`,
        expect.anything(),
      );
    });

    it("authorizes client public key listed in ACCOUNTS", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => `
          VERSION = "2.0.0"
          SIGNING_KEY = "${domainSigningKeypair.publicKey()}"
          ACCOUNTS = ["${authorizedAccountKeypair.publicKey()}"]
        `,
      });

      const result = await verifyClientDomain(
        DOMAIN,
        authorizedAccountKeypair.publicKey(),
        { fetchFn: mockFetch as any },
      );

      expect(result.authorized).toBe(true);
      expect(result.source).toBe("stellar_toml");
      expect(result.accounts).toContain(authorizedAccountKeypair.publicKey());
    });

    it("rejects when key is not in SIGNING_KEY nor ACCOUNTS (mismatched domain)", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => `
          VERSION = "2.0.0"
          SIGNING_KEY = "${domainSigningKeypair.publicKey()}"
          ACCOUNTS = ["${authorizedAccountKeypair.publicKey()}"]
        `,
      });

      const mockResolver = jest.fn().mockResolvedValue([]);

      const result = await verifyClientDomain(
        DOMAIN,
        unauthorizedKeypair.publicKey(),
        {
          fetchFn: mockFetch as any,
          dnsResolver: mockResolver,
        },
      );

      expect(result.authorized).toBe(false);
      expect(result.source).toBe("none");
      expect(result.error).toContain("does not authorize client public key");
    });
  });

  describe("verifyClientDomain via DNS TXT fallback", () => {
    it("authorizes client public key matching DNS TXT record", async () => {
      // TOML fails (e.g. 404)
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      // DNS resolver returns TXT with stellar_signing_key
      const mockResolver = jest.fn().mockImplementation(async (queryName: string) => {
        if (queryName === `_stellar.${DOMAIN}`) {
          return [[`stellar_signing_key=${clientKeypair.publicKey()}`]];
        }
        return [];
      });

      const result = await verifyClientDomain(
        DOMAIN,
        clientKeypair.publicKey(),
        {
          fetchFn: mockFetch as any,
          dnsResolver: mockResolver,
        },
      );

      expect(result.authorized).toBe(true);
      expect(result.source).toBe("dns_txt");
      expect(mockResolver).toHaveBeenCalled();
    });

    it("handles DNS lookup failures (e.g. ENOTFOUND) gracefully", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const mockResolver = jest
        .fn()
        .mockRejectedValue(new Error("queryTxt ENOTFOUND"));

      const result = await verifyClientDomain(
        DOMAIN,
        clientKeypair.publicKey(),
        {
          fetchFn: mockFetch as any,
          dnsResolver: mockResolver,
        },
      );

      expect(result.authorized).toBe(false);
      expect(result.source).toBe("none");
    });
  });

  describe("assertClientDomainAuthorized (400 Bad Request enforcement)", () => {
    it("throws 400 Bad Request error when domain does not authorize key", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => `
          VERSION = "2.0.0"
          SIGNING_KEY = "${domainSigningKeypair.publicKey()}"
        `,
      });
      const mockResolver = jest.fn().mockResolvedValue([]);

      await expect(
        assertClientDomainAuthorized(DOMAIN, unauthorizedKeypair.publicKey(), {
          fetchFn: mockFetch as any,
          dnsResolver: mockResolver,
        }),
      ).rejects.toThrow();

      try {
        await assertClientDomainAuthorized(
          DOMAIN,
          unauthorizedKeypair.publicKey(),
          { fetchFn: mockFetch as any, dnsResolver: mockResolver },
        );
      } catch (err: any) {
        expect(err.statusCode || err.status).toBe(400);
        expect(err.message).toContain("does not authorize client public key");
      }
    });

    it("succeeds when domain authorizes key", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => `
          VERSION = "2.0.0"
          SIGNING_KEY = "${domainSigningKeypair.publicKey()}"
        `,
      });

      await expect(
        assertClientDomainAuthorized(DOMAIN, domainSigningKeypair.publicKey(), {
          fetchFn: mockFetch as any,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("Integration with Sep10Service", () => {
    const serverKeypair = StellarSdk.Keypair.random();
    const config = {
      signingKey: serverKeypair.secret(),
      webAuthDomain: "https://api.example.com",
      networkPassphrase: StellarSdk.Networks.TESTNET,
      jwtSecret: "test-jwt-secret-key",
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

    it("generates challenge and validates client domain authorization against stellar.toml", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => `
          SIGNING_KEY = "${domainSigningKeypair.publicKey()}"
          ACCOUNTS = ["${clientKeypair.publicKey()}"]
        `,
      });

      const challengeRes = await service.generateChallenge(
        clientKeypair.publicKey(),
        undefined,
        DOMAIN,
        mockFetch as any,
      );

      const tx = StellarSdk.TransactionBuilder.fromXDR(
        challengeRes.transaction,
        StellarSdk.Networks.TESTNET,
      ) as StellarSdk.Transaction;

      tx.sign(clientKeypair);
      tx.sign(domainSigningKeypair);

      const tokenRes = await service.verifyChallenge(
        tx.toXDR(),
        clientKeypair.publicKey(),
        mockFetch as any,
      );

      expect(tokenRes.token).toBeDefined();
    });

    it("rejects challenge verification if client domain does not authorize the signing account", async () => {
      const otherDomainKeypair = StellarSdk.Keypair.random();
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => `
          SIGNING_KEY = "${otherDomainKeypair.publicKey()}"
        `,
      });

      const challengeRes = await service.generateChallenge(
        clientKeypair.publicKey(),
        undefined,
        DOMAIN,
        mockFetch as any,
      );

      const tx = StellarSdk.TransactionBuilder.fromXDR(
        challengeRes.transaction,
        StellarSdk.Networks.TESTNET,
      ) as StellarSdk.Transaction;

      tx.sign(clientKeypair);
      tx.sign(domainSigningKeypair);

      await expect(
        service.verifyChallenge(
          tx.toXDR(),
          clientKeypair.publicKey(),
          mockFetch as any,
        ),
      ).rejects.toThrow();
    });
  });
});
