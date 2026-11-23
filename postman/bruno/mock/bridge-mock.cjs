/**
 * Throwaway mock of the mobile-money bridge API, used to smoke-test the Bruno
 * collection without a backend: it mirrors the real SEP-10 challenge/verify
 * shapes from src/stellar/sep10.ts (GET /sep10 → {transaction,
 * network_passphrase}, POST /sep10 → {token}) and answers every other endpoint
 * the collection calls with a plausible body.
 *
 * Usage:
 *   npm run bruno:mock      # terminal 1 (listens on :3000)
 *   npm run bruno:run       # terminal 2 — expect 23/23 requests, 41/41 tests
 *
 * The `SERVER_KP` keypair below only exists so the mock can sign challenges;
 * it is never used by the API itself.
 */
"use strict";

const http = require("http");
const crypto = require("crypto");

const {
  Account,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
} = require("@stellar/stellar-sdk");
const jwt = require("jsonwebtoken");

const PASSPHRASE = "Test SDF Network ; September 2015";
const SERVER_KP = Keypair.fromSecret(
  "SCJLGPINJ53CQN3BYZCWUAE7MQ7PST36FBH7GSOANXXPWK2S7PMJZQYF",
);
const JWT_SECRET = "mock-bridge-secret";
const WEB_AUTH_DOMAIN = "localhost:3000";
const CHALLENGE_TTL = 300;

function buildChallenge(clientPublicKey, homeDomain) {
  const now = Math.floor(Date.now() / 1000);
  const timebounds = {
    minTime: String(now),
    maxTime: String(now + CHALLENGE_TTL),
  };
  const source = new Account(clientPublicKey, "-1");
  const nonce = crypto.randomBytes(64);
  const memoBytes = crypto.randomBytes(32);

  let builder = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: PASSPHRASE,
    timebounds,
  });
  builder = builder.addMemo(Memo.hash(memoBytes));
  builder = builder.addOperation(
    Operation.manageData({
      name: `${homeDomain || WEB_AUTH_DOMAIN} auth`,
      value: nonce,
      source: clientPublicKey,
    }),
  );
  builder = builder.addOperation(
    Operation.manageData({
      name: "web_auth_domain",
      value: WEB_AUTH_DOMAIN,
      source: SERVER_KP.publicKey(),
    }),
  );
  const tx = builder.build();
  tx.sign(SERVER_KP);
  return tx;
}

/**
 * js-xdr (as bundled with stellar-sdk 15) exposes decorated-signature fields as
 * accessors rather than plain properties — the backend handles this in
 * src/stellar/sep10.ts via readDecoratedSignature().
 */
function readSignature(sig) {
  const value =
    typeof sig.signature === "function"
      ? sig.signature.call(sig)
      : sig.signature;
  return Buffer.from(value);
}

function verifyWith(keypair, hash, sig) {
  try {
    return keypair.verify(hash, readSignature(sig));
  } catch (_err) {
    return false;
  }
}

function verifyChallenge(xdr) {
  const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);

  if (tx.sequence !== "0")
    throw new Error("Transaction sequence number must be 0");
  const tb = tx.timeBounds;
  if (!tb || !tb.maxTime) throw new Error("Transaction must have timebounds");
  const now = Math.floor(Date.now() / 1000);
  if (now > Number(tb.maxTime)) throw new Error("Transaction has expired");
  if (!tx.operations.every((op) => op.type === "manageData")) {
    throw new Error("Transaction must contain only manageData operations");
  }

  const clientPublicKey = tx.operations[0].source || tx.source;
  const hash = tx.hash();

  const signedByServer = tx.signatures.some((sig) =>
    verifyWith(SERVER_KP, hash, sig),
  );
  if (!signedByServer)
    throw new Error("Transaction is not signed by the server");

  const clientKp = Keypair.fromPublicKey(clientPublicKey);
  const signedByClient = tx.signatures.some((sig) =>
    verifyWith(clientKp, hash, sig),
  );
  if (!signedByClient)
    throw new Error("Transaction is not signed by the client");

  return clientPublicKey;
}

function issueToken(account) {
  const iat = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: account,
      iss: WEB_AUTH_DOMAIN,
      iat,
      exp: iat + 3600,
      jti: crypto.randomUUID(),
      home_domain: WEB_AUTH_DOMAIN,
    },
    JWT_SECRET,
    { algorithm: "HS256" },
  );
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  if (status >= 400) {
    console.log(`  -> ${status} ${payload}`);
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost:3000");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    const route = `${req.method} ${url.pathname}`;
    console.log(`${route}${url.search}`);

    try {
      switch (route) {
        case "GET /health":
        case "GET /ready":
          return json(res, 200, { status: "ok", uptime: 1 });

        case "GET /sep10": {
          const account = url.searchParams.get("account");
          const homeDomain = url.searchParams.get("home_domain");
          if (!account) return json(res, 400, { error: "account required" });
          const challenge = buildChallenge(account, homeDomain);
          return json(res, 200, {
            transaction: challenge.toXDR(),
            network_passphrase: PASSPHRASE,
          });
        }

        case "POST /sep10": {
          const account = verifyChallenge(body.transaction);
          return json(res, 200, { token: issueToken(account) });
        }

        case "POST /api/auth/login":
          return json(res, 200, { status: "otp_sent" });

        case "POST /api/auth/verify":
          return json(res, 200, { valid: Boolean(body.token) });

        case "GET /api/auth/me":
          return json(res, 200, {
            id: "mock-user-uuid-1",
            phone_number: "+237670000000",
          });

        case "GET /sep12/customer":
          return json(res, 200, { id: "sep12-1", status: "ACCEPTED" });

        case "PUT /sep12/customer":
          return json(res, 200, { id: "sep12-1" });

        case "GET /api/kyc/status":
          return json(res, 200, { status: "approved", level: 2 });

        case "GET /sep38/info":
          return json(res, 200, {
            assets: ["iso4217:XAF", "stellar:USDC"],
            pairs: [{ sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC" }],
          });

        case "GET /sep38/prices":
          return json(res, 200, { price: "605.35" });

        case "POST /sep38/quote":
          return json(res, 201, {
            id: "quote-123",
            expires_at: new Date(Date.now() + 60000).toISOString(),
            total_price: "605.35",
          });

        case "GET /sep38/quote/quote-123":
          return json(res, 200, {
            id: "quote-123",
            expires_at: new Date(Date.now() + 60000).toISOString(),
          });

        case "POST /api/fees/estimate":
          return json(res, 200, { fee: 100, total: 25100, currency: "XAF" });

        case "GET /sep24/info":
          return json(res, 200, {
            deposit: { USDC: { min_amount: "1", fee_fixed: 0 } },
            withdraw: { USDC: { min_amount: "1", fee_fixed: 1 } },
          });

        case "POST /sep24/transactions/deposit/interactive":
          return json(res, 200, {
            id: "dep-1",
            url: "https://stellar.local/sep24/deposit/dep-1",
          });

        case "POST /sep24/transactions/withdraw/interactive":
          return json(res, 200, {
            id: "wd-1",
            url: "https://stellar.local/sep24/withdraw/wd-1",
          });

        case "GET /sep24/transaction":
          return json(res, 200, {
            transaction: {
              id: url.searchParams.get("id") || "dep-1",
              status: "incomplete",
            },
          });

        case "POST /api/transactions/deposit":
          return json(res, 201, {
            id: "txn-dep-1",
            status: "PENDING",
            amount: body.amount,
          });

        case "POST /api/transactions/withdraw":
          return json(res, 201, {
            id: "txn-wd-1",
            status: "PENDING",
            amount: body.amount,
          });

        case "GET /api/transactions":
          return json(res, 200, []);

        default: {
          if (
            req.method === "GET" &&
            url.pathname.startsWith("/api/transactions/")
          ) {
            return json(res, 200, {
              id: url.pathname.split("/").pop(),
              status: "PENDING",
            });
          }
          return json(res, 404, { error: `no mock for ${route}` });
        }
      }
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  });
});

server.listen(3000, () => {
  console.log("mock bridge listening on http://localhost:3000");
});
