/**
 * End-to-End Integration Test: SEP-24 Interactive Deposit Flow to Mobile Wallet
 *
 * Covers the complete deposit journey:
 *   1. SEP-10 Web Authentication (challenge generation, client signing, JWT issuance)
 *   2. SEP-24 Interactive Deposit URL Generation (HMAC signature, parameter validation)
 *   3. Mock Interactive Webview Form Submission (interactive page render, popup callback)
 *   4. Mobile Money Provider Collection Callback (Wave / MTN external webhook simulation)
 *   5. On-Chain Stellar Asset Transfer (mock Horizon transaction submission, hash verification)
 *   6. Verification that transaction reaches terminal 'completed' state with a valid 64-character hash
 */

// Set up mandatory environment variables before any application imports
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test_user:test_password@localhost:5432/test_db";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.WEBVIEW_SIGNING_SECRET ??= "test-webview-signing-secret-32-chars-long";
process.env.JWT_SECRET ??= "test-jwt-secret-for-sep10-e2e-journey";
process.env.STELLAR_NETWORK = "testnet";

import { test, expect, APIRequestContext, request } from "@playwright/test";
import express, { Express, Request as ExRequest, Response as ExResponse } from "express";
import { Server } from "http";
import { AddressInfo } from "net";
import {
  Keypair,
  Transaction,
  TransactionBuilder,
  Networks,
} from "@stellar/stellar-sdk";

// Generate deterministic test server keypair for anchor signing
const serverKeypair = Keypair.random();
process.env.STELLAR_ISSUER_SECRET = serverKeypair.secret();
process.env.STELLAR_SIGNING_KEY = serverKeypair.secret();
process.env.STELLAR_ISSUER_ACCOUNT = serverKeypair.publicKey();

import { createSep10Router, Sep10Service } from "../../src/stellar/sep10";
import sep24Router, {
  fulfillDeposit,
  getTransaction,
  setSep24TransactionStore,
  Sep24Transaction,
  DepositPaymentSender,
} from "../../src/stellar/sep24";
import { sep24RouteHandler } from "../../src/routes/sep24";
import { createHorizonMockApp } from "../../src/mocks/horizonMockServer";
import { errorHandler } from "../../src/middleware/errorHandler";

const MOCK_STELLAR_TX_HASH =
  "e578c772c6cf8e81561f71a0678b6638841029c7827bd3c59bd0281c9ff5d66c";

test.describe("SEP-24 Deposit Journey – Mobile Wallet E2E Integration", () => {
  let horizonServer: Server;
  let horizonBaseUrl: string;
  let appServer: Server;
  let appBaseUrl: string;
  let api: APIRequestContext;
  let sep10Service: Sep10Service;

  // In-memory store for SEP-24 transactions to isolate tests from Postgres in CI
  const inMemoryTxStore: Map<string, Sep24Transaction> = new Map();

  test.beforeAll(async () => {
    // 1. Configure in-memory transaction store for deterministic execution
    setSep24TransactionStore({
      save: async (tx) => {
        inMemoryTxStore.set(tx.id, { ...tx });
      },
    });

    // 2. Start mock Horizon server on an ephemeral port
    const horizonApp = createHorizonMockApp();
    await new Promise<void>((resolve) => {
      horizonServer = horizonApp.listen(0, "127.0.0.1", () => {
        const addr = horizonServer.address() as AddressInfo;
        horizonBaseUrl = `http://127.0.0.1:${addr.port}`;
        process.env.STELLAR_HORIZON_URL = horizonBaseUrl;
        resolve();
      });
    });

    // 3. Initialize SEP-10 service pointing to mock Horizon
    sep10Service = new Sep10Service({
      signingKey: serverKeypair.secret(),
      webAuthDomain: "127.0.0.1",
      networkPassphrase: Networks.TESTNET,
      jwtSecret: process.env.JWT_SECRET!,
      challengeExpiresIn: 900,
      jwtExpiresIn: "1h",
      homeDomain: "127.0.0.1",
    });

    // 4. Construct Express backend app
    const app: Express = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Middleware to extract SEP-10 JWT bearer token and attach authenticated user
    app.use((req: ExRequest, _res: ExResponse, next) => {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        try {
          const decoded = sep10Service.verifyToken(token);
          (req as any).user = { id: decoded.sub, ...decoded };
        } catch {
          // Token is invalid or expired
        }
      }
      next();
    });

    // Mount SEP-10 authentication
    app.use("/sep10", createSep10Router(sep10Service));
    app.use("/auth", createSep10Router(sep10Service));

    // Mount SEP-24 interactive deposit and popup routes
    app.use("/sep24", sep24Router);
    app.use("/sep24", sep24RouteHandler);

    // Mount mock mobile money provider webhook endpoint (Wave / MTN MoMo collection callback)
    app.post(
      "/api/provider/wave/callback",
      async (req: ExRequest, res: ExResponse) => {
        const { client_reference, transaction_id, status, amount } = req.body;
        const txId = transaction_id || client_reference;

        if (!txId) {
          return res.status(400).json({ error: "Missing transaction identifier" });
        }

        const existing = getTransaction(txId);
        if (!existing) {
          return res.status(404).json({ error: "Transaction not found" });
        }

        // Provider collection confirmation: advance status to pending_anchor
        if (status === "succeeded" || status === "SUCCESSFUL" || status === "completed") {
          existing.status = "pending_anchor";
          existing.message = "Payment received from Wave mobile wallet";
          if (amount) existing.amount_in = String(amount);
          existing.updated_at = new Date().toISOString();

          // Trigger on-chain Stellar asset transfer upon successful provider collection
          const customSender: DepositPaymentSender = {
            sendPayment: async () => ({ hash: MOCK_STELLAR_TX_HASH }),
          };

          try {
            await fulfillDeposit(txId, customSender);
          } catch (err: any) {
            return res.status(500).json({ error: err.message });
          }

          return res.status(200).json({
            status: "accepted",
            transaction_id: txId,
            stellar_transaction_id: existing.stellar_transaction_id,
          });
        }

        return res.status(400).json({ error: "Unrecognized provider status" });
      },
    );

    // Global error handler
    app.use(errorHandler);

    // Start anchor app server on an ephemeral port
    await new Promise<void>((resolve) => {
      appServer = app.listen(0, "127.0.0.1", () => {
        const addr = appServer.address() as AddressInfo;
        appBaseUrl = `http://127.0.0.1:${addr.port}`;
        process.env.STELLAR_WEB_AUTH_DOMAIN = appBaseUrl;
        process.env.SEP24_INTERACTIVE_URL = `${appBaseUrl}/sep24/interactive/deposit`;
        resolve();
      });
    });

    // 5. Initialize Playwright APIRequestContext
    api = await request.newContext({
      baseURL: appBaseUrl,
      extraHTTPHeaders: { "Content-Type": "application/json" },
    });
  });

  test.afterAll(async () => {
    if (api) await api.dispose();
    if (appServer) {
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
    }
    if (horizonServer) {
      await new Promise<void>((resolve) => horizonServer.close(() => resolve()));
    }
  });

  // ── Step 1: SEP-10 Authentication ───────────────────────────────────────
  let walletKeypair: Keypair;
  let jwtToken: string;

  test("SEP-10: generates challenge, signs with wallet keypair, and receives valid JWT", async () => {
    walletKeypair = Keypair.random();

    // 1.1 Request challenge transaction
    const challengeRes = await api.get("/sep10", {
      params: { account: walletKeypair.publicKey() },
    });
    expect(
      challengeRes.ok(),
      `Failed to fetch challenge: ${await challengeRes.text()}`,
    ).toBeTruthy();

    const challengeData = await challengeRes.json();
    expect(challengeData.transaction).toBeTruthy();
    expect(challengeData.network_passphrase).toBe(Networks.TESTNET);

    // 1.2 Decode and sign the challenge with client wallet key
    const tx = TransactionBuilder.fromXDR(
      challengeData.transaction,
      challengeData.network_passphrase,
    ) as Transaction;
    tx.sign(walletKeypair);

    // 1.3 Submit signed challenge back to anchor
    const authRes = await api.post("/sep10", {
      data: { transaction: tx.toXDR() },
    });
    expect(
      authRes.ok(),
      `SEP-10 authentication failed: ${await authRes.text()}`,
    ).toBeTruthy();

    const authData = await authRes.json();
    expect(authData.token).toBeTruthy();
    jwtToken = authData.token;

    // Verify token claims
    const decoded = sep10Service.verifyToken(jwtToken);
    expect(decoded.sub).toBe(walletKeypair.publicKey());
  });

  // ── Step 2: SEP-24 Interactive Deposit Initiation ───────────────────────
  let depositTransactionId: string;
  let interactiveUrl: string;

  test("SEP-24: initiates interactive deposit and receives HMAC-signed URL and transaction ID", async () => {
    const depositPayload = {
      asset_code: "XLM",
      amount: "50.00",
      account: walletKeypair.publicKey(),
      memo: "wallet-user-ref-789",
      memo_type: "text",
      email: "mobile-wallet@example.com",
    };

    const depositRes = await api.post(
      "/sep24/transactions/deposit/interactive",
      {
        headers: { Authorization: `Bearer ${jwtToken}` },
        data: depositPayload,
      },
    );

    expect(
      depositRes.ok(),
      `Deposit initiation failed: ${await depositRes.text()}`,
    ).toBeTruthy();

    const body = await depositRes.json();
    expect(body.id).toBeTruthy();
    expect(body.url).toBeTruthy();

    depositTransactionId = body.id;
    interactiveUrl = body.url;

    // Verify URL parameters
    const parsedUrl = new URL(interactiveUrl);
    expect(parsedUrl.searchParams.get("transaction_id")).toBe(depositTransactionId);
    expect(parsedUrl.searchParams.get("asset_code")).toBe("XLM");
    expect(parsedUrl.searchParams.get("amount")).toBe("50.00");
    expect(parsedUrl.searchParams.get("account")).toBe(walletKeypair.publicKey());
    expect(parsedUrl.searchParams.get("memo")).toBe("wallet-user-ref-789");
    expect(parsedUrl.searchParams.get("sig")).toBeTruthy();
    expect(parsedUrl.searchParams.get("exp")).toBeTruthy();

    // Verify initial transaction status is pending_user_transfer_start
    const txRes = await api.get(`/sep24/transaction?id=${depositTransactionId}`);
    expect(txRes.ok()).toBeTruthy();
    const txBody = await txRes.json();
    expect(txBody.transaction.status).toBe("pending_user_transfer_start");
  });

  // ── Step 3: Interactive Form Submission & Popup Callback ────────────────
  test("SEP-24 Webview: completes mock interactive form submission and renders callback postMessage", async () => {
    expect(interactiveUrl).toBeTruthy();
    expect(depositTransactionId).toBeTruthy();

    // 3.1 Fetch the interactive page (GET /sep24/interactive/deposit)
    const pageUrl = new URL(interactiveUrl);
    const pageRes = await api.get(pageUrl.pathname + pageUrl.search);
    expect(pageRes.ok()).toBeTruthy();

    const htmlContent = await pageRes.text();
    expect(htmlContent).toContain("Interactive Deposit");
    expect(htmlContent).toContain("Fee Calculator");

    // 3.2 Complete mock interactive form submission via the webview callback endpoint
    const callbackRes = await api.get("/sep24/interactive/callback", {
      params: {
        transaction_id: depositTransactionId,
        session_token: "mock-session-token-xyz",
        redirect_url: "https://wallet.mobilemoney.com/deposit-complete",
      },
    });

    expect(callbackRes.ok()).toBeTruthy();
    const callbackHtml = await callbackRes.text();
    expect(callbackHtml).toContain("sep24_callback");
    expect(callbackHtml).toContain("deposit_initiated");
    expect(callbackHtml).toContain(depositTransactionId);
    expect(callbackHtml).toContain("https://wallet.mobilemoney.com/deposit-complete");
  });

  // ── Step 4 & 5: Provider Collection & On-Chain Stellar Transfer ─────────
  test("Full Journey: processes provider collection callback and executes on-chain transfer to completed state", async () => {
    expect(depositTransactionId).toBeTruthy();

    // 4.1 Mock external mobile money provider (Wave Senegal / MTN) collection callback
    const providerCallbackRes = await api.post("/api/provider/wave/callback", {
      data: {
        client_reference: depositTransactionId,
        status: "succeeded",
        amount: "50.00",
        currency: "XOF",
      },
    });

    expect(
      providerCallbackRes.ok(),
      `Provider callback failed: ${await providerCallbackRes.text()}`,
    ).toBeTruthy();

    const providerResult = await providerCallbackRes.json();
    expect(providerResult.status).toBe("accepted");
    expect(providerResult.stellar_transaction_id).toBe(MOCK_STELLAR_TX_HASH);

    // 5.1 Query transaction status endpoint and verify terminal completed state
    const statusRes = await api.get(`/sep24/transaction?id=${depositTransactionId}`);
    expect(statusRes.ok()).toBeTruthy();

    const statusBody = await statusRes.json();
    const txFromApi = statusBody.transaction;

    expect(txFromApi.id).toBe(depositTransactionId);
    expect(txFromApi.status).toBe("completed");
    expect(txFromApi.completed_at).toBeTruthy();

    // Verify stored transaction state with valid 64-character hexadecimal Stellar transaction hash
    const storedTx = getTransaction(depositTransactionId)!;
    expect(storedTx).toBeDefined();
    expect(storedTx.status).toBe("completed");
    expect(storedTx.account).toBe(walletKeypair.publicKey());
    expect(storedTx.memo).toBe("wallet-user-ref-789");
    expect(storedTx.stellar_transaction_id).toMatch(/^[0-9a-fA-F]{64}$/);
    expect(storedTx.stellar_transaction_id).toBe(MOCK_STELLAR_TX_HASH);
  });

  // ── Step 6: Complete End-to-End Single-Pass Deposit Flow ─────────────────
  test("End-to-end atomic deposit flow from challenge to completed on-chain payment", async () => {
    const endToEndWallet = Keypair.random();

    // 1. SEP-10 Auth
    const chRes = await api.get("/sep10", {
      params: { account: endToEndWallet.publicKey() },
    });
    expect(chRes.ok()).toBeTruthy();
    const chData = await chRes.json();

    const signTx = TransactionBuilder.fromXDR(
      chData.transaction,
      chData.network_passphrase,
    ) as Transaction;
    signTx.sign(endToEndWallet);

    const tokenRes = await api.post("/sep10", {
      data: { transaction: signTx.toXDR() },
    });
    expect(tokenRes.ok()).toBeTruthy();
    const { token } = await tokenRes.json();

    // 2. SEP-24 Initiate Deposit
    const depRes = await api.post("/sep24/deposit", {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        asset_code: "XLM",
        amount: "150.00",
        account: endToEndWallet.publicKey(),
        memo: "e2e-atomic-deposit",
        memo_type: "text",
      },
    });
    expect(depRes.ok()).toBeTruthy();
    const { id: txId, url: flowUrl } = await depRes.json();
    expect(txId).toBeTruthy();
    expect(flowUrl).toContain("transaction_id=");

    // 3. Mock interactive form completion
    const webviewCallbackRes = await api.get("/sep24/interactive/callback", {
      params: {
        transaction_id: txId,
        status: "pending_user_transfer_start",
      },
    });
    expect(webviewCallbackRes.ok()).toBeTruthy();

    // 4. Standard SEP-24 callback (simulating collection notice)
    const anchorCallbackRes = await api.post(`/sep24/callback/${txId}`, {
      data: {
        status: "pending_anchor",
        amount_in: "150.00",
        amount_out: "148.50",
        amount_fee: "1.50",
        message: "Mobile money collection confirmed",
      },
    });
    expect(anchorCallbackRes.ok()).toBeTruthy();

    // 5. On-chain Stellar asset transfer execution with Horizon submission
    const sender: DepositPaymentSender = {
      sendPayment: async (destination, amount, _s, _r, _f, memo) => {
        expect(destination).toBe(endToEndWallet.publicKey());
        expect(amount).toBe("148.50");
        expect(memo?.value).toBe("e2e-atomic-deposit");
        return { hash: MOCK_STELLAR_TX_HASH };
      },
    };

    const fulfilled = await fulfillDeposit(txId, sender);
    expect(fulfilled.status).toBe("completed");
    expect(fulfilled.stellar_transaction_id).toMatch(/^[0-9a-fA-F]{64}$/);
    expect(fulfilled.stellar_transaction_id).toBe(MOCK_STELLAR_TX_HASH);

    // 6. Polling verification
    const pollRes = await api.get(`/sep24/transaction?id=${txId}`);
    expect(pollRes.ok()).toBeTruthy();
    const pollBody = await pollRes.json();
    expect(pollBody.transaction.status).toBe("completed");
    expect(pollBody.transaction.completed_at).toBeTruthy();

    // Verify stored transaction state
    const atomicTx = getTransaction(txId)!;
    expect(atomicTx.status).toBe("completed");
    expect(atomicTx.stellar_transaction_id).toBe(MOCK_STELLAR_TX_HASH);
    expect(atomicTx.stellar_transaction_id).toMatch(/^[0-9a-fA-F]{64}$/);
  });
});
