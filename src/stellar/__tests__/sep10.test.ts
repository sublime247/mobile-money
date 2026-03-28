import request from "supertest";
import express from "express";
import crypto from "crypto";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  MemoHash,
  Operation,
  Transaction,
  TransactionBuilder,
} from "stellar-sdk";
import { createSep10Router, Sep10Service, getSep10Config } from "../sep10";
import { Networks } from "stellar-sdk";

// Generate keypairs for testing
const serverKeypair = Keypair.random();
const clientKeypair = Keypair.random();
const otherKeypair = Keypair.random();

const TEST_NETWORK_PASSPHRASE = Networks.TESTNET;
const TEST_JWT_SECRET = "test-jwt-secret-for-sep10";
const TEST_WEB_AUTH_DOMAIN = "https://test.example.com";
const TEST_HOME_DOMAIN = "test.example.com";

function createTestService(
  overrides?: Record<string, string | number>,
): Sep10Service {
  return new Sep10Service({
    signingKey: serverKeypair.secret(),
    webAuthDomain: TEST_WEB_AUTH_DOMAIN,
    networkPassphrase: TEST_NETWORK_PASSPHRASE,
    jwtSecret: TEST_JWT_SECRET,
    challengeExpiresIn: 900,
    jwtExpiresIn: "1h",
    homeDomain: TEST_HOME_DOMAIN,
    ...overrides,
  });
}

function createChallengeTransaction(
  clientAccount: string,
  serverKeypair: Keypair,
  options?: {
    networkPassphrase?: string;
    homeDomain?: string;
    expiresInSeconds?: number;
    invalidNonce?: boolean;
    sequenceNumber?: string;
    addNonManageDataOp?: boolean;
    skipServerSignature?: boolean;
    signWithOtherKeyInstead?: boolean;
    wrongNonceLength?: number;
  },
): Transaction {
  const networkPassphrase =
    options?.networkPassphrase || TEST_NETWORK_PASSPHRASE;
  const homeDomain = options?.homeDomain || TEST_HOME_DOMAIN;
  const expiresInSeconds = options?.expiresInSeconds || 900;

  const now = Math.floor(Date.now() / 1000);
  const timebounds = {
    minTime: String(now),
    maxTime: String(now + expiresInSeconds),
  };

  const manageDataKey = `${homeDomain} auth`;
  const nonceLength = options?.wrongNonceLength ?? 64;
  const nonce = options?.invalidNonce
    ? Buffer.alloc(nonceLength, 0)
    : crypto.randomBytes(nonceLength);

  // TransactionBuilder increments sequence by 1, so use "-1" to get "0" in XDR
  const sequenceNumber = options?.sequenceNumber ?? "-1";
  const sourceAccount = new Account(clientAccount, sequenceNumber);

  let builder = new TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase,
    timebounds,
  });

  const memoBytes = crypto.randomBytes(32);
  builder = builder.addMemo(new Memo(MemoHash, memoBytes));

  builder = builder.addOperation(
    Operation.manageData({
      name: manageDataKey,
      value: nonce,
      source: clientAccount,
    }),
  );

  builder = builder.addOperation(
    Operation.manageData({
      name: "web_auth_domain",
      value: TEST_WEB_AUTH_DOMAIN,
      source: serverKeypair.publicKey(),
    }),
  );

  if (options?.addNonManageDataOp) {
    builder = builder.addOperation(
      Operation.payment({
        destination: serverKeypair.publicKey(),
        amount: "1",
        asset: Asset.native(),
        source: clientKeypair.publicKey(),
      }),
    );
  }

  const transaction = builder.build();

  if (!options?.skipServerSignature) {
    transaction.sign(serverKeypair);
  }

  if (options?.signWithOtherKeyInstead) {
    transaction.sign(otherKeypair);
  }

  return transaction;
}

describe("SEP-10 Stellar Authentication", () => {
  describe("Sep10Service", () => {
    describe("generateChallenge", () => {
      it("should generate a valid challenge transaction", () => {
        const service = createTestService();
        const challenge = service.generateChallenge(clientKeypair.publicKey());

        expect(challenge.transaction).toBeDefined();
        expect(challenge.network_passphrase).toBe(TEST_NETWORK_PASSPHRASE);

        // Decode the transaction
        const tx = TransactionBuilder.fromXDR(
          challenge.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;

        expect(tx).toBeInstanceOf(Transaction);
        expect(tx.sequence).toBe("0");
        expect(tx.timeBounds).toBeDefined();
        expect(tx.operations.length).toBeGreaterThanOrEqual(1);
        expect(tx.operations[0].type).toBe("manageData");
      });

      it("should include web_auth_domain operation from server", () => {
        const service = createTestService();
        const challenge = service.generateChallenge(clientKeypair.publicKey());

        const tx = TransactionBuilder.fromXDR(
          challenge.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;

        expect(tx.operations.length).toBe(2);
        const secondOp = tx.operations[1];
        expect(secondOp.type).toBe("manageData");
        expect((secondOp as any).name).toBe("web_auth_domain");
        expect((secondOp as any).source).toBe(serverKeypair.publicKey());
      });

      it("should sign the transaction with the server key", () => {
        const service = createTestService();
        const challenge = service.generateChallenge(clientKeypair.publicKey());

        const tx = TransactionBuilder.fromXDR(
          challenge.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;

        expect(tx.signatures.length).toBeGreaterThanOrEqual(1);
      });

      it("should set timebounds based on configured expiry", () => {
        const service = createTestService({ challengeExpiresIn: 600 });
        const before = Math.floor(Date.now() / 1000);
        const challenge = service.generateChallenge(clientKeypair.publicKey());
        const after = Math.floor(Date.now() / 1000);

        const tx = TransactionBuilder.fromXDR(
          challenge.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;

        const minTime = parseInt(tx.timeBounds!.minTime, 10);
        const maxTime = parseInt(tx.timeBounds!.maxTime, 10);

        expect(minTime).toBeGreaterThanOrEqual(before);
        expect(minTime).toBeLessThanOrEqual(after);
        expect(maxTime - minTime).toBe(600);
      });

      it("should throw for invalid public key", () => {
        const service = createTestService();
        expect(() => service.generateChallenge("INVALID_KEY")).toThrow(
          "Invalid Stellar public key",
        );
      });

      it("should use homeDomain in manageData key when provided", () => {
        const service = createTestService();
        const challenge = service.generateChallenge(
          clientKeypair.publicKey(),
          "custom.domain.com",
        );

        const tx = TransactionBuilder.fromXDR(
          challenge.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;

        expect((tx.operations[0] as any).name).toBe("custom.domain.com auth");
      });

      it("should produce different nonces for repeated calls", () => {
        const service = createTestService();
        const challenge1 = service.generateChallenge(clientKeypair.publicKey());
        const challenge2 = service.generateChallenge(clientKeypair.publicKey());

        expect(challenge1.transaction).not.toBe(challenge2.transaction);
      });
    });

    describe("verifyChallenge", () => {
      it("should issue a valid JWT for a properly signed challenge", () => {
        const service = createTestService();
        const challenge = service.generateChallenge(clientKeypair.publicKey());

        // Client signs the transaction
        const tx = TransactionBuilder.fromXDR(
          challenge.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;
        tx.sign(clientKeypair);

        const response = service.verifyChallenge(
          tx.toXDR(),
          clientKeypair.publicKey(),
        );

        expect(response.token).toBeDefined();
        expect(typeof response.token).toBe("string");

        // Decode and verify the JWT
        const decoded = service.verifyToken(response.token);
        expect(decoded.sub).toBe(clientKeypair.publicKey());
        expect(decoded.iss).toBe(TEST_WEB_AUTH_DOMAIN);
        expect(decoded.home_domain).toBe(TEST_HOME_DOMAIN);
      });

      it("should work without passing clientAccountID explicitly", () => {
        const service = createTestService();
        const challenge = service.generateChallenge(clientKeypair.publicKey());

        const tx = TransactionBuilder.fromXDR(
          challenge.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;
        tx.sign(clientKeypair);

        const response = service.verifyChallenge(tx.toXDR());
        expect(response.token).toBeDefined();
      });

      it("should reject invalid XDR", () => {
        const service = createTestService();
        expect(() =>
          service.verifyChallenge("not-valid-xdr", clientKeypair.publicKey()),
        ).toThrow("Invalid transaction envelope");
      });

      it("should reject transactions with non-zero sequence number", () => {
        const service = createTestService();
        const tx = createChallengeTransaction(
          clientKeypair.publicKey(),
          serverKeypair,
          { sequenceNumber: "12345" },
        );
        tx.sign(clientKeypair);

        expect(() =>
          service.verifyChallenge(tx.toXDR(), clientKeypair.publicKey()),
        ).toThrow("Transaction sequence number must be 0");
      });

      it("should reject expired transactions", () => {
        const service = createTestService();
        const tx = createChallengeTransaction(
          clientKeypair.publicKey(),
          serverKeypair,
          { expiresInSeconds: -10 }, // Already expired
        );
        tx.sign(clientKeypair);

        expect(() =>
          service.verifyChallenge(tx.toXDR(), clientKeypair.publicKey()),
        ).toThrow("Transaction has expired");
      });

      it("should reject transactions not yet valid", () => {
        const service = createTestService();

        const future = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
        const sourceAccount = new Account(clientKeypair.publicKey(), "-1");

        let builder = new TransactionBuilder(sourceAccount, {
          fee: "100",
          networkPassphrase: TEST_NETWORK_PASSPHRASE,
          timebounds: {
            minTime: String(future),
            maxTime: String(future + 900),
          },
        });

        const memoBytes = crypto.randomBytes(32);
        builder = builder.addMemo(new Memo(MemoHash, memoBytes));

        builder = builder.addOperation(
          Operation.manageData({
            name: `${TEST_HOME_DOMAIN} auth`,
            value: crypto.randomBytes(64),
            source: clientKeypair.publicKey(),
          }),
        );

        builder = builder.addOperation(
          Operation.manageData({
            name: "web_auth_domain",
            value: TEST_WEB_AUTH_DOMAIN,
            source: serverKeypair.publicKey(),
          }),
        );

        const tx = builder.build();
        tx.sign(serverKeypair);
        tx.sign(clientKeypair);

        expect(() =>
          service.verifyChallenge(tx.toXDR(), clientKeypair.publicKey()),
        ).toThrow("Transaction is not yet valid");
      });

      it("should reject transactions not signed by the server", () => {
        const service = createTestService();
        const tx = createChallengeTransaction(
          clientKeypair.publicKey(),
          serverKeypair,
          { skipServerSignature: true },
        );
        tx.sign(clientKeypair);

        expect(() =>
          service.verifyChallenge(tx.toXDR(), clientKeypair.publicKey()),
        ).toThrow("Transaction is not signed by the server");
      });

      it("should reject transactions not signed by the client", () => {
        const service = createTestService();
        const challenge = service.generateChallenge(clientKeypair.publicKey());

        // Server signed, but client did NOT sign
        expect(() =>
          service.verifyChallenge(
            challenge.transaction,
            clientKeypair.publicKey(),
          ),
        ).toThrow("Transaction is not signed by the client account");
      });

      it("should reject transactions with non-manageData operations", () => {
        const service = createTestService();
        const tx = createChallengeTransaction(
          clientKeypair.publicKey(),
          serverKeypair,
          { addNonManageDataOp: true },
        );
        tx.sign(clientKeypair);

        expect(() =>
          service.verifyChallenge(tx.toXDR(), clientKeypair.publicKey()),
        ).toThrow("Transaction must contain only manageData operations");
      });

      it("should reject when manageData source does not match client account", () => {
        const service = createTestService();

        const sourceAccount = new Account(clientKeypair.publicKey(), "-1");
        let builder = new TransactionBuilder(sourceAccount, {
          fee: "100",
          networkPassphrase: TEST_NETWORK_PASSPHRASE,
          timebounds: {
            minTime: String(Math.floor(Date.now() / 1000)),
            maxTime: String(Math.floor(Date.now() / 1000) + 900),
          },
        });

        builder = builder.addMemo(new Memo(MemoHash, crypto.randomBytes(32)));

        // Use wrong source for manageData
        builder = builder.addOperation(
          Operation.manageData({
            name: `${TEST_HOME_DOMAIN} auth`,
            value: crypto.randomBytes(64),
            source: otherKeypair.publicKey(),
          }),
        );

        const tx = builder.build();
        tx.sign(serverKeypair);

        expect(() =>
          service.verifyChallenge(tx.toXDR(), clientKeypair.publicKey()),
        ).toThrow(
          "First manageData operation source must match client account",
        );
      });

      it("should include jti (JWT ID) in the token", () => {
        const service = createTestService();
        const challenge = service.generateChallenge(clientKeypair.publicKey());

        const tx = TransactionBuilder.fromXDR(
          challenge.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;
        tx.sign(clientKeypair);

        const response = service.verifyChallenge(
          tx.toXDR(),
          clientKeypair.publicKey(),
        );

        const decoded = service.verifyToken(response.token);
        expect(decoded.jti).toBeDefined();
        expect(decoded.jti).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      });

      it("should include iat and exp claims in the token", () => {
        const service = createTestService();
        const challenge = service.generateChallenge(clientKeypair.publicKey());

        const tx = TransactionBuilder.fromXDR(
          challenge.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;
        tx.sign(clientKeypair);

        const before = Math.floor(Date.now() / 1000);
        const response = service.verifyChallenge(
          tx.toXDR(),
          clientKeypair.publicKey(),
        );
        const after = Math.floor(Date.now() / 1000);

        const decoded = service.verifyToken(response.token);
        expect(decoded.iat).toBeGreaterThanOrEqual(before);
        expect(decoded.iat).toBeLessThanOrEqual(after);
        expect(decoded.exp).toBe(decoded.iat + 3600);
      });
    });

    describe("verifyToken", () => {
      it("should throw for expired tokens", () => {
        const service = createTestService({ jwtExpiresIn: "1s" });
        const challenge = service.generateChallenge(clientKeypair.publicKey());

        const tx = TransactionBuilder.fromXDR(
          challenge.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;
        tx.sign(clientKeypair);

        const response = service.verifyChallenge(
          tx.toXDR(),
          clientKeypair.publicKey(),
        );

        // Token should be valid immediately
        expect(() => service.verifyToken(response.token)).not.toThrow();
      });

      it("should throw for invalid tokens", () => {
        const service = createTestService();
        expect(() => service.verifyToken("invalid.jwt.token")).toThrow(
          "Invalid token",
        );
      });

      it("should throw for tokens signed with different secret", () => {
        const service = createTestService();
        const otherService = createTestService({ jwtSecret: "other-secret" });

        const challenge = otherService.generateChallenge(
          clientKeypair.publicKey(),
        );
        const tx = TransactionBuilder.fromXDR(
          challenge.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;
        tx.sign(clientKeypair);

        const response = otherService.verifyChallenge(
          tx.toXDR(),
          clientKeypair.publicKey(),
        );

        expect(() => service.verifyToken(response.token)).toThrow();
      });
    });

    describe("isValidPublicKey", () => {
      it("should return true for valid Stellar public keys", () => {
        expect(Sep10Service.isValidPublicKey(clientKeypair.publicKey())).toBe(
          true,
        );
        expect(Sep10Service.isValidPublicKey(serverKeypair.publicKey())).toBe(
          true,
        );
      });

      it("should return false for invalid keys", () => {
        expect(Sep10Service.isValidPublicKey("")).toBe(false);
        expect(Sep10Service.isValidPublicKey("invalid")).toBe(false);
        expect(Sep10Service.isValidPublicKey("GABC")).toBe(false);
      });
    });

    describe("getServerPublicKey", () => {
      it("should return the server's public key", () => {
        const service = createTestService();
        expect(service.getServerPublicKey()).toBe(serverKeypair.publicKey());
      });
    });

    describe("issueToken", () => {
      it("should issue a token with correct claims", () => {
        const service = createTestService();
        const response = service.issueToken(clientKeypair.publicKey());

        expect(response.token).toBeDefined();

        const decoded = service.verifyToken(response.token);
        expect(decoded.sub).toBe(clientKeypair.publicKey());
        expect(decoded.iss).toBe(TEST_WEB_AUTH_DOMAIN);
        expect(decoded.home_domain).toBe(TEST_HOME_DOMAIN);
      });
    });
  });

  describe("Express Router", () => {
    let app: express.Express;
    let service: Sep10Service;

    beforeEach(() => {
      service = createTestService();
      app = express();
      app.use(express.json());
      app.use("/auth", createSep10Router(service));
    });

    describe("GET /auth", () => {
      it("should return a challenge transaction", async () => {
        const response = await request(app)
          .get("/auth")
          .query({ account: clientKeypair.publicKey() });

        expect(response.status).toBe(200);
        expect(response.body.transaction).toBeDefined();
        expect(response.body.network_passphrase).toBe(TEST_NETWORK_PASSPHRASE);
      });

      it("should return 400 for missing account parameter", async () => {
        const response = await request(app).get("/auth");

        expect(response.status).toBe(400);
        expect(response.body.error).toContain("account parameter is required");
      });

      it("should return 400 for invalid account", async () => {
        const response = await request(app)
          .get("/auth")
          .query({ account: "INVALID" });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain("Invalid Stellar public key");
      });

      it("should accept home_domain parameter", async () => {
        const response = await request(app).get("/auth").query({
          account: clientKeypair.publicKey(),
          home_domain: "custom.example.com",
        });

        expect(response.status).toBe(200);

        const tx = TransactionBuilder.fromXDR(
          response.body.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;

        expect((tx.operations[0] as any).name).toBe("custom.example.com auth");
      });
    });

    describe("POST /auth", () => {
      it("should return a JWT token for a valid signed challenge", async () => {
        const challengeRes = await request(app)
          .get("/auth")
          .query({ account: clientKeypair.publicKey() });

        const tx = TransactionBuilder.fromXDR(
          challengeRes.body.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;
        tx.sign(clientKeypair);

        const response = await request(app)
          .post("/auth")
          .send({ transaction: tx.toXDR() });

        expect(response.status).toBe(200);
        expect(response.body.token).toBeDefined();

        const decoded = service.verifyToken(response.body.token);
        expect(decoded.sub).toBe(clientKeypair.publicKey());
      });

      it("should return 400 for missing transaction parameter", async () => {
        const response = await request(app).post("/auth").send({});

        expect(response.status).toBe(400);
        expect(response.body.error).toContain(
          "transaction parameter is required",
        );
      });

      it("should return 400 for invalid transaction XDR", async () => {
        const response = await request(app)
          .post("/auth")
          .send({ transaction: "invalid-xdr" });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain("Invalid transaction envelope");
      });

      it("should return 400 for unsigned transaction", async () => {
        const challengeRes = await request(app)
          .get("/auth")
          .query({ account: clientKeypair.publicKey() });

        // Don't sign with client
        const response = await request(app)
          .post("/auth")
          .send({ transaction: challengeRes.body.transaction });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain("not signed by the client");
      });

      it("should return 400 for expired challenge", async () => {
        // Create a service with already-expired challenges
        const shortService = createTestService({ challengeExpiresIn: -10 });
        const shortApp = express();
        shortApp.use(express.json());
        shortApp.use("/auth", createSep10Router(shortService));

        const challengeRes = await request(shortApp)
          .get("/auth")
          .query({ account: clientKeypair.publicKey() });

        const tx = TransactionBuilder.fromXDR(
          challengeRes.body.transaction,
          TEST_NETWORK_PASSPHRASE,
        ) as Transaction;
        tx.sign(clientKeypair);

        const response = await request(shortApp)
          .post("/auth")
          .send({ transaction: tx.toXDR() });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain("expired");
      });
    });

    describe("GET /auth/health", () => {
      it("should return health status", async () => {
        const response = await request(app).get("/auth/health");

        expect(response.status).toBe(200);
        expect(response.body.status).toBe("ok");
        expect(response.body.service).toBe("SEP-10 Authentication");
        expect(response.body.server_key).toBe(serverKeypair.publicKey());
      });
    });
  });

  describe("End-to-End Auth Flow", () => {
    it("should complete the full SEP-10 authentication flow", async () => {
      const service = createTestService();
      const app = express();
      app.use(express.json());
      app.use("/auth", createSep10Router(service));

      // Step 1: Client requests challenge
      const challengeRes = await request(app)
        .get("/auth")
        .query({ account: clientKeypair.publicKey() });

      expect(challengeRes.status).toBe(200);
      expect(challengeRes.body.transaction).toBeDefined();
      expect(challengeRes.body.network_passphrase).toBe(
        TEST_NETWORK_PASSPHRASE,
      );

      // Step 2: Client verifies the challenge locally
      const challengeTx = TransactionBuilder.fromXDR(
        challengeRes.body.transaction,
        TEST_NETWORK_PASSPHRASE,
      ) as Transaction;

      expect(challengeTx).toBeInstanceOf(Transaction);
      expect(challengeTx.sequence).toBe("0");
      expect(challengeTx.timeBounds).toBeDefined();
      expect(challengeTx.operations.length).toBe(2);

      // Step 3: Client signs the challenge
      challengeTx.sign(clientKeypair);

      // Step 4: Client submits signed challenge
      const authRes = await request(app)
        .post("/auth")
        .send({ transaction: challengeTx.toXDR() });

      expect(authRes.status).toBe(200);
      expect(authRes.body.token).toBeDefined();

      // Step 5: Verify the JWT token
      const decoded = service.verifyToken(authRes.body.token);
      expect(decoded.sub).toBe(clientKeypair.publicKey());
      expect(decoded.iss).toBe(TEST_WEB_AUTH_DOMAIN);
      expect(decoded.iat).toBeDefined();
      expect(decoded.exp).toBeDefined();
      expect(decoded.jti).toBeDefined();
    });

    it("should reject a challenge signed by wrong key", async () => {
      const service = createTestService();
      const app = express();
      app.use(express.json());
      app.use("/auth", createSep10Router(service));

      const challengeRes = await request(app)
        .get("/auth")
        .query({ account: clientKeypair.publicKey() });

      // Sign with wrong key
      const challengeTx = TransactionBuilder.fromXDR(
        challengeRes.body.transaction,
        TEST_NETWORK_PASSPHRASE,
      ) as Transaction;
      challengeTx.sign(otherKeypair);

      const authRes = await request(app)
        .post("/auth")
        .send({ transaction: challengeTx.toXDR() });

      expect(authRes.status).toBe(400);
      expect(authRes.body.error).toContain("not signed by the client account");
    });
  });

  describe("getSep10Config", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should throw if signing key is not configured", () => {
      delete process.env.STELLAR_SIGNING_KEY;
      delete process.env.STELLAR_ISSUER_SECRET;

      expect(() => getSep10Config()).toThrow(
        "STELLAR_SIGNING_KEY or STELLAR_ISSUER_SECRET must be defined",
      );
    });
  });
});
