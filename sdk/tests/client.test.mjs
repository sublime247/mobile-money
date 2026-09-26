import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("TypeScript SDK source files exist with required methods", () => {
  const clientPath = path.resolve(__dirname, "../ts/client.ts");
  const typesPath = path.resolve(__dirname, "../ts/types.ts");
  const errorsPath = path.resolve(__dirname, "../ts/errors.ts");

  assert.ok(fs.existsSync(clientPath), "client.ts must exist");
  assert.ok(fs.existsSync(typesPath), "types.ts must exist");
  assert.ok(fs.existsSync(errorsPath), "errors.ts must exist");

  const clientContent = fs.readFileSync(clientPath, "utf-8");
  assert.ok(clientContent.includes("auth(params: AuthParams)"), "Must implement auth()");
  assert.ok(clientContent.includes("createCustomer(params: CustomerParams)"), "Must implement createCustomer()");
  assert.ok(clientContent.includes("getQuote(params: QuoteParams)"), "Must implement getQuote()");
  assert.ok(clientContent.includes("initiateDeposit(params: DepositParams)"), "Must implement initiateDeposit()");
  assert.ok(clientContent.includes("getTransactionStatus(transactionId: string)"), "Must implement getTransactionStatus()");
});

test("StellarBridgeClient validates configuration and inputs", async () => {
  // Import the TS source directly using node experimental-strip-types
  const { StellarBridgeClient } = await import("../ts/client.ts");
  const { ValidationError } = await import("../ts/errors.ts");

  assert.throws(
    () => new StellarBridgeClient({ baseUrl: "" }),
    (err) => err instanceof ValidationError && err.message.includes("baseUrl is required"),
    "Should throw ValidationError if baseUrl is empty"
  );

  const client = new StellarBridgeClient({ baseUrl: "https://api.bridge.stellarwave.io" });
  assert.strictEqual(client.getJwtToken(), undefined);

  client.setJwtToken("mock-jwt-token");
  assert.strictEqual(client.getJwtToken(), "mock-jwt-token");

  await assert.rejects(
    () => client.auth({ account: "" }),
    (err) => err instanceof ValidationError,
    "auth() requires account"
  );

  await assert.rejects(
    () => client.createCustomer({ account: "" }),
    (err) => err instanceof ValidationError,
    "createCustomer() requires account"
  );

  await assert.rejects(
    () => client.getQuote({ sellAsset: "", buyAsset: "" }),
    (err) => err instanceof ValidationError,
    "getQuote() requires assets"
  );

  await assert.rejects(
    () => client.initiateDeposit({ assetCode: "", account: "" }),
    (err) => err instanceof ValidationError,
    "initiateDeposit() requires assetCode and account"
  );
});

test("StellarBridgeClient interacts with mock transport for all operations", async () => {
  const { StellarBridgeClient } = await import("../ts/client.ts");

  const mockResponses = {
    "/sep10/auth": {
      transaction: "AAAAAgAAAABmockChallengeXdr...",
      network_passphrase: "Test SDF Network ; September 2015",
    },
    "/sep12/customer": {
      id: "cust-uuid-1234",
      status: "ACCEPTED",
    },
    "/sep38/quote": {
      id: "quote-uuid-5678",
      price: "600.0",
      total_price: "602.5",
      sell_asset: "iso4217:XAF",
      sell_amount: "60250",
      buy_asset: "stellar:USDC:GBBD47IF...",
      buy_amount: "100.0",
      expires_at: "2026-10-01T00:00:00Z",
    },
    "/sep24/transactions/deposit/interactive": {
      url: "https://bridge.stellarwave.io/sep24/flow?token=deposit-token-999",
      id: "tx-sep24-999",
      status: "pending_user_transfer_start",
    },
    "/sep24/transaction": {
      transaction: {
        id: "tx-sep24-999",
        status: "completed",
        amount_in: "60250",
        amount_out: "100.0",
      },
    },
  };

  const client = new StellarBridgeClient({
    baseUrl: "https://api.bridge.stellarwave.io",
    jwtToken: "mock-token",
  });

  // Inject mock transport
  client.transport = {
    async request(opts) {
      for (const [endpoint, data] of Object.entries(mockResponses)) {
        if (opts.url.includes(endpoint)) {
          return { status: 200, data, headers: {} };
        }
      }
      return { status: 404, data: { error: "Not found" }, headers: {} };
    },
  };

  // 1. Test auth()
  const authRes = await client.auth({ account: "GBBD47IF..." });
  assert.ok(authRes.challengeXdr, "Should return challenge XDR");

  // 2. Test createCustomer()
  const custRes = await client.createCustomer({
    account: "GBBD47IF...",
    firstName: "Amina",
    lastName: "Diallo",
  });
  assert.strictEqual(custRes.id, "cust-uuid-1234");
  assert.strictEqual(custRes.status, "ACCEPTED");

  // 3. Test getQuote()
  const quoteRes = await client.getQuote({
    sellAsset: "iso4217:XAF",
    buyAsset: "stellar:USDC:GBBD47IF...",
    sellAmount: "60250",
  });
  assert.strictEqual(quoteRes.id, "quote-uuid-5678");
  assert.strictEqual(quoteRes.price, "600.0");

  // 4. Test initiateDeposit()
  const depRes = await client.initiateDeposit({
    assetCode: "USDC",
    account: "GBBD47IF...",
    amount: "100.0",
  });
  assert.ok(depRes.url.includes("sep24/flow"));
  assert.strictEqual(depRes.id, "tx-sep24-999");

  // 5. Test getTransactionStatus()
  const txStatus = await client.getTransactionStatus("tx-sep24-999");
  assert.strictEqual(txStatus.status, "completed");
  assert.strictEqual(txStatus.amountOut, "100.0");
});

test("ESM and CommonJS build artifacts can be imported and executed", async () => {
  // Test ESM dist build
  const esmModule = await import("../dist/index.js");
  assert.ok(esmModule.StellarBridgeClient, "ESM should export StellarBridgeClient");
  assert.ok(esmModule.FetchTransport, "ESM should export FetchTransport");
  const esmClient = new esmModule.StellarBridgeClient({ baseUrl: "https://api.bridge.stellarwave.io" });
  assert.strictEqual(typeof esmClient.auth, "function");
  assert.strictEqual(typeof esmClient.createCustomer, "function");
  assert.strictEqual(typeof esmClient.getQuote, "function");
  assert.strictEqual(typeof esmClient.initiateDeposit, "function");

  // Test CommonJS dist build
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const cjsModule = require("../dist/index.cjs");
  assert.ok(cjsModule.StellarBridgeClient, "CommonJS should export StellarBridgeClient");
  assert.ok(cjsModule.FetchTransport, "CommonJS should export FetchTransport");
  const cjsClient = new cjsModule.StellarBridgeClient({ baseUrl: "https://api.bridge.stellarwave.io" });
  assert.strictEqual(typeof cjsClient.auth, "function");
  assert.strictEqual(typeof cjsClient.createCustomer, "function");
  assert.strictEqual(typeof cjsClient.getQuote, "function");
  assert.strictEqual(typeof cjsClient.initiateDeposit, "function");
});
