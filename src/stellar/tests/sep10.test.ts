/**
 * SEP-10 client attribution (#2426)
 *
 * Covers validation of the `client_domain` challenge parameter against the
 * SIGNING_KEY published in the client's stellar.toml, and validation of the
 * requested `home_domain` against the server's configured HOME_DOMAIN(s).
 */
import express from "express";
import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";
import jwt from "jsonwebtoken";
import {
  Sep10Service,
  clearClientDomainCache,
  createSep10Router,
  fetchClientDomainSigningKey,
  parseClientDomain,
  parseStellarTomlSigningKey,
} from "../sep10";
import { errorHandler } from "../../middleware/errorHandler";

const serverKeypair = StellarSdk.Keypair.random();
const clientKeypair = StellarSdk.Keypair.random();
const walletSigningKeypair = StellarSdk.Keypair.random();
const attackerKeypair = StellarSdk.Keypair.random();

const NETWORK = StellarSdk.Networks.TESTNET;
const HOME_DOMAIN = "api.example.com";
const WALLET_DOMAIN = "wallet.example.com";

const config = {
  signingKey: serverKeypair.secret(),
  webAuthDomain: "https://api.example.com",
  networkPassphrase: NETWORK,
  jwtSecret: "sep10-client-attribution-secret",
  challengeExpiresIn: 900,
  jwtExpiresIn: "1h",
  homeDomain: HOME_DOMAIN,
  additionalHomeDomains: ["anchor.example.org"],
};

function tomlResponse(body: string) {
  return { ok: true, status: 200, text: async () => body };
}

function walletToml(signingKey = walletSigningKeypair.publicKey()) {
  return `
VERSION = "2.0.0"
NETWORK_PASSPHRASE = "${NETWORK}"
SIGNING_KEY = "${signingKey}"
`;
}

function mockFetchFor(body: string) {
  return jest.fn().mockResolvedValue(tomlResponse(body)) as unknown as jest.Mock &
    typeof fetch;
}

function parseTx(xdr: string): StellarSdk.Transaction {
  return StellarSdk.TransactionBuilder.fromXDR(
    xdr,
    NETWORK,
  ) as StellarSdk.Transaction;
}

function createService(): Sep10Service {
  const service = new Sep10Service(config);
  jest.spyOn(service, "fetchAccountSigners").mockResolvedValue({
    signers: [{ publicKey: clientKeypair.publicKey(), weight: 1 }],
    thresholds: { lowThreshold: 1, mediumThreshold: 1, highThreshold: 1 },
    masterWeight: 1,
  });
  return service;
}

beforeEach(() => {
  clearClientDomainCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("parseClientDomain", () => {
  it.each([
    ["wallet.example.com", "wallet.example.com"],
    ["  Wallet.Example.COM ", "wallet.example.com"],
    ["sub.wallet-app.io", "sub.wallet-app.io"],
    ["localhost:8000", "localhost:8000"],
  ])("accepts %p", (raw, expected) => {
    expect(parseClientDomain(raw)).toBe(expected);
  });

  it.each([
    "https://wallet.example.com",
    "wallet.example.com/.well-known/stellar.toml",
    "wallet.example.com:8443",
    "user@wallet.example.com",
    "wallet.example.com?x=1",
    "10.0.0.5",
    "nodot",
    "",
  ])("rejects %p", (raw) => {
    expect(() => parseClientDomain(raw)).toThrow("Invalid client_domain");
  });

  it("rejects non-string values such as repeated query parameters", () => {
    expect(() => parseClientDomain(["a.com", "b.com"])).toThrow(
      "Invalid client_domain",
    );
  });
});

describe("parseStellarTomlSigningKey", () => {
  const key = walletSigningKeypair.publicKey();

  it("reads the top-level SIGNING_KEY", () => {
    expect(parseStellarTomlSigningKey(walletToml())).toBe(key);
  });

  it("supports single quotes and trailing comments", () => {
    expect(
      parseStellarTomlSigningKey(`SIGNING_KEY = '${key}' # wallet key`),
    ).toBe(key);
  });

  it("ignores SIGNING_KEY declared inside a table", () => {
    const toml = `
VERSION = "2.0.0"

[[CURRENCIES]]
code = "USDC"
SIGNING_KEY = "${key}"
`;
    expect(parseStellarTomlSigningKey(toml)).toBeNull();
  });

  it("ignores commented-out keys", () => {
    expect(parseStellarTomlSigningKey(`# SIGNING_KEY = "${key}"`)).toBeNull();
  });

  it("does not fall back to URI_REQUEST_SIGNER or similarly named keys", () => {
    const toml = `
URI_REQUEST_SIGNER = "${key}"
WEB_AUTH_SIGNING_KEY = "${key}"
signing_key = "${key}"
`;
    expect(parseStellarTomlSigningKey(toml)).toBeNull();
  });

  it("rejects a SIGNING_KEY that is not a valid ed25519 public key", () => {
    expect(
      parseStellarTomlSigningKey(`SIGNING_KEY = "${walletSigningKeypair.secret()}"`),
    ).toBeNull();
  });
});

describe("fetchClientDomainSigningKey", () => {
  it("fetches stellar.toml over https from the well-known path", async () => {
    const fetchFn = mockFetchFor(walletToml());

    await expect(
      fetchClientDomainSigningKey(WALLET_DOMAIN, fetchFn),
    ).resolves.toBe(walletSigningKeypair.publicKey());
    expect(fetchFn).toHaveBeenCalledWith(
      `https://${WALLET_DOMAIN}/.well-known/stellar.toml`,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("caches the resolved key per domain", async () => {
    const fetchFn = mockFetchFor(walletToml());

    await fetchClientDomainSigningKey(WALLET_DOMAIN, fetchFn);
    await fetchClientDomainSigningKey(WALLET_DOMAIN.toUpperCase(), fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a stellar.toml with no SIGNING_KEY", async () => {
    await expect(
      fetchClientDomainSigningKey(WALLET_DOMAIN, mockFetchFor('VERSION = "2.0.0"')),
    ).rejects.toThrow("No valid SIGNING_KEY");
  });

  it("rejects an oversized stellar.toml", async () => {
    const huge = walletToml() + "#".repeat(101 * 1024);
    await expect(
      fetchClientDomainSigningKey(WALLET_DOMAIN, mockFetchFor(huge)),
    ).rejects.toThrow("100KB");
  });

  it("rejects HTTP errors", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch;
    await expect(
      fetchClientDomainSigningKey(WALLET_DOMAIN, fetchFn),
    ).rejects.toThrow("Client domain verification failed: HTTP 404");
  });

  it("never fetches for a malformed domain", async () => {
    const fetchFn = mockFetchFor(walletToml());
    await expect(
      fetchClientDomainSigningKey("https://evil.example.com/x", fetchFn),
    ).rejects.toThrow("Client domain verification failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("Sep10Service client attribution", () => {
  it("adds a client_domain operation sourced from the published SIGNING_KEY", async () => {
    const service = createService();
    const challenge = await service.generateChallenge(
      clientKeypair.publicKey(),
      undefined,
      WALLET_DOMAIN,
      mockFetchFor(walletToml()),
    );

    const tx = parseTx(challenge.transaction);
    const op = tx.operations.find(
      (o: any) => o.name === "client_domain",
    ) as any;
    expect(op).toBeDefined();
    expect(op.source).toBe(walletSigningKeypair.publicKey());
    expect(Buffer.from(op.value).toString("utf8")).toBe(WALLET_DOMAIN);
  });

  it("issues a token for a valid client domain signature", async () => {
    const service = createService();
    const fetchFn = mockFetchFor(walletToml());
    const challenge = await service.generateChallenge(
      clientKeypair.publicKey(),
      undefined,
      WALLET_DOMAIN,
      fetchFn,
    );

    const tx = parseTx(challenge.transaction);
    tx.sign(clientKeypair);
    tx.sign(walletSigningKeypair);

    const { token } = await service.verifyChallenge(
      tx.toXDR(),
      clientKeypair.publicKey(),
      fetchFn,
    );
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded.sub).toBe(clientKeypair.publicKey());
    expect(decoded.home_domain).toBe(HOME_DOMAIN);
  });

  it("rejects a spoofed client domain signed by a key that is not published", async () => {
    const service = createService();
    const fetchFn = mockFetchFor(walletToml());
    const challenge = await service.generateChallenge(
      clientKeypair.publicKey(),
      undefined,
      WALLET_DOMAIN,
      fetchFn,
    );

    // The attacker claims wallet.example.com but can only sign with their own key.
    const tx = parseTx(challenge.transaction);
    tx.sign(clientKeypair);
    tx.sign(attackerKeypair);

    await expect(
      service.verifyChallenge(tx.toXDR(), clientKeypair.publicKey(), fetchFn),
    ).rejects.toThrow("Transaction is not signed by client domain SIGNING_KEY");
  });

  it("rejects when the domain's published SIGNING_KEY no longer matches the challenge", async () => {
    const service = createService();
    const challenge = await service.generateChallenge(
      clientKeypair.publicKey(),
      undefined,
      WALLET_DOMAIN,
      mockFetchFor(walletToml()),
    );

    const tx = parseTx(challenge.transaction);
    tx.sign(clientKeypair);
    tx.sign(walletSigningKeypair);

    // stellar.toml now publishes a different key (e.g. domain takeover or
    // the challenge was attributed to a domain the signer does not control).
    clearClientDomainCache();
    await expect(
      service.verifyChallenge(
        tx.toXDR(),
        clientKeypair.publicKey(),
        mockFetchFor(walletToml(attackerKeypair.publicKey())),
      ),
    ).rejects.toThrow("client_domain operation source does not match");
  });

  it("rejects challenge generation when the client domain's stellar.toml cannot be verified", async () => {
    const service = createService();
    await expect(
      service.generateChallenge(
        clientKeypair.publicKey(),
        undefined,
        WALLET_DOMAIN,
        mockFetchFor('VERSION = "2.0.0"'),
      ),
    ).rejects.toThrow("Client domain verification failed");
  });
});

describe("Sep10Service home domain validation", () => {
  it("defaults to the configured HOME_DOMAIN", async () => {
    const service = createService();
    const challenge = await service.generateChallenge(clientKeypair.publicKey());
    expect((parseTx(challenge.transaction).operations[0] as any).name).toBe(
      `${HOME_DOMAIN} auth`,
    );
  });

  it("accepts an additional configured home domain and stamps it on the JWT", async () => {
    const service = createService();
    const challenge = await service.generateChallenge(
      clientKeypair.publicKey(),
      "ANCHOR.example.org",
    );
    const tx = parseTx(challenge.transaction);
    expect((tx.operations[0] as any).name).toBe("anchor.example.org auth");

    tx.sign(clientKeypair);
    const { token } = await service.verifyChallenge(
      tx.toXDR(),
      clientKeypair.publicKey(),
    );
    expect((jwt.decode(token) as jwt.JwtPayload).home_domain).toBe(
      "anchor.example.org",
    );
  });

  it("rejects a home_domain the server does not serve", async () => {
    const service = createService();
    await expect(
      service.generateChallenge(clientKeypair.publicKey(), "evil.example.com"),
    ).rejects.toThrow("Invalid home_domain");
  });

  it("rejects a server-signed challenge whose auth operation names a foreign home domain", async () => {
    const service = createService();
    const now = Math.floor(Date.now() / 1000);
    const tx = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(clientKeypair.publicKey(), "-1"),
      {
        fee: "100",
        networkPassphrase: NETWORK,
        timebounds: { minTime: String(now), maxTime: String(now + 900) },
      },
    )
      .addOperation(
        StellarSdk.Operation.manageData({
          name: "evil.example.com auth",
          value: Buffer.alloc(64, 1),
          source: clientKeypair.publicKey(),
        }),
      )
      .build();
    tx.sign(serverKeypair);
    tx.sign(clientKeypair);

    await expect(
      service.verifyChallenge(tx.toXDR(), clientKeypair.publicKey()),
    ).rejects.toThrow("Invalid home domain in challenge transaction");
  });
});

describe("GET /auth client attribution", () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/auth", createSep10Router(createService()));
    app.use(errorHandler);
    return app;
  }

  it("returns a challenge attributed to a valid client domain", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(tomlResponse(walletToml()) as unknown as Response);

    const res = await request(buildApp())
      .get("/auth")
      .query({ account: clientKeypair.publicKey(), client_domain: WALLET_DOMAIN });

    expect(res.status).toBe(200);
    const op = parseTx(res.body.transaction).operations.find(
      (o: any) => o.name === "client_domain",
    ) as any;
    expect(op.source).toBe(walletSigningKeypair.publicKey());
  });

  it("rejects a malformed client_domain parameter without fetching", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch");

    const res = await request(buildApp())
      .get("/auth")
      .query({
        account: clientKeypair.publicKey(),
        client_domain: "http://169.254.169.254/latest",
      });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an unsupported home_domain parameter", async () => {
    const res = await request(buildApp())
      .get("/auth")
      .query({
        account: clientKeypair.publicKey(),
        home_domain: "evil.example.com",
      });

    expect(res.status).toBe(400);
  });
});
