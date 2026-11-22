import request from "supertest";
import express from "express";
import { randomBytes } from "crypto";
import { Keypair, Memo } from "@stellar/stellar-sdk";

jest.mock("../../src/middleware/rateLimit", () => ({
  sep24RateLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../src/services/stellar/webhooks", () => ({
  enqueueSepWebhook: jest.fn().mockResolvedValue(undefined),
}));

import sep24Router, {
  DepositPaymentSender,
  Sep24Transaction,
  fulfillDeposit,
  getTransaction,
  initiateWithdrawal,
  setSep24TransactionStore,
  updateTransactionStatus,
} from "../../src/stellar/sep24";
import { errorHandler } from "../../src/middleware/errorHandler";

const saved: Sep24Transaction[] = [];
setSep24TransactionStore({
  save: async (tx) => {
    saved.push(tx);
  },
});

const app = express();
app.use(express.json());
app.use("/sep24", sep24Router);
app.use(errorHandler);

const ENDPOINT = "/sep24/transactions/deposit/interactive";

/** Each test uses a fresh account to stay under the per-account limit. */
const deposit = (extra: Record<string, unknown> = {}) =>
  request(app)
    .post(ENDPOINT)
    .send({
      asset_code: "XLM",
      amount: "10",
      account: Keypair.random().publicKey(),
      ...extra,
    });

function fakeSender(hash = "stellar-hash") {
  const calls: Array<{ destination: string; amount: string; memo?: Memo }> = [];
  const sender: DepositPaymentSender = {
    sendPayment: jest.fn(async (destination, amount, _s, _r, _f, memo) => {
      calls.push({ destination, amount, memo });
      return { hash };
    }),
  };
  return { sender, calls };
}

beforeEach(() => {
  saved.length = 0;
});

describe("POST /sep24/transactions/deposit/interactive — memo", () => {
  it("accepts memo and memo_type and stores them on the transaction", async () => {
    const res = await deposit({ memo: "1234567890", memo_type: "id" });

    expect(res.status).toBe(200);
    const tx = getTransaction(res.body.id)!;
    expect(tx).toMatchObject({ memo: "1234567890", memo_type: "id" });

    const url = new URL(res.body.url);
    expect(url.searchParams.get("memo")).toBe("1234567890");
    expect(url.searchParams.get("memo_type")).toBe("id");
  });

  it("persists the memo fields", async () => {
    const memo = randomBytes(32).toString("base64");
    const res = await deposit({ memo, memo_type: "hash" });

    expect(res.status).toBe(200);
    expect(saved).toContainEqual(
      expect.objectContaining({ id: res.body.id, memo, memo_type: "hash" }),
    );
  });

  it("defaults memo_type to text", async () => {
    const res = await deposit({ memo: "exchange-user-7" });

    expect(res.status).toBe(200);
    expect(getTransaction(res.body.id)!.memo_type).toBe("text");
  });

  it("still accepts deposits without a memo on the legacy path", async () => {
    const res = await request(app).post("/sep24/deposit").send({
      asset_code: "XLM",
      amount: "10",
      account: Keypair.random().publicKey(),
    });

    expect(res.status).toBe(200);
    const tx = getTransaction(res.body.id)!;
    expect(tx.memo).toBeUndefined();
    expect(tx.memo_type).toBeUndefined();
  });

  it.each([
    [{ memo: "not-a-number", memo_type: "id" }, /id memo/],
    [{ memo: "short", memo_type: "hash" }, /hash memo/],
    [{ memo: "x".repeat(29), memo_type: "text" }, /at most 28 bytes/],
    [{ memo_type: "id" }, /memo is required/],
    [{ memo: "1", memo_type: "return" }, /memo_type/],
  ])("rejects %j with 400", async (extra, message) => {
    const res = await deposit(extra);

    expect(res.status).toBe(400);
    expect(res.body.error ?? res.body.message).toMatch(message);
  });
});

describe("fulfillDeposit", () => {
  it("attaches the wallet's memo to the Stellar payment", async () => {
    const res = await deposit({ memo: "98765", memo_type: "id" });
    const { sender, calls } = fakeSender();

    const tx = await fulfillDeposit(res.body.id, sender);

    expect(calls).toHaveLength(1);
    expect(calls[0].destination).toBe(tx.account);
    expect(calls[0].amount).toBe("10");
    expect(calls[0].memo!.type).toBe("id");
    expect(calls[0].memo!.value).toBe("98765");
    expect(tx).toMatchObject({
      status: "completed",
      stellar_transaction_id: "stellar-hash",
    });
    expect(saved[saved.length - 1]).toMatchObject({
      id: tx.id,
      status: "completed",
      stellar_transaction_id: "stellar-hash",
    });
  });

  it("decodes a base64 hash memo to its raw 32 bytes", async () => {
    const bytes = randomBytes(32);
    const res = await deposit({
      memo: bytes.toString("base64"),
      memo_type: "hash",
    });
    const { sender, calls } = fakeSender();

    await fulfillDeposit(res.body.id, sender);

    expect(calls[0].memo!.type).toBe("hash");
    expect(Buffer.from(calls[0].memo!.value as Buffer)).toEqual(bytes);
  });

  it("sends no memo when the wallet did not supply one", async () => {
    const res = await deposit();
    const { sender, calls } = fakeSender();

    await fulfillDeposit(res.body.id, sender);

    expect(calls[0].memo).toBeUndefined();
  });

  it("pays amount_out when the anchor has set it", async () => {
    const res = await deposit();
    getTransaction(res.body.id)!.amount_out = "9.5";
    const { sender, calls } = fakeSender();

    await fulfillDeposit(res.body.id, sender);

    expect(calls[0].amount).toBe("9.5");
  });

  it("does not pay twice", async () => {
    const res = await deposit();
    const { sender } = fakeSender();

    await fulfillDeposit(res.body.id, sender);
    await fulfillDeposit(res.body.id, sender);

    expect(sender.sendPayment).toHaveBeenCalledTimes(1);
  });

  it("leaves the deposit pending_stellar and rethrows when submission fails", async () => {
    const res = await deposit({ memo: "1", memo_type: "id" });
    const sender: DepositPaymentSender = {
      sendPayment: jest.fn().mockRejectedValue(new Error("tx_failed")),
    };

    await expect(fulfillDeposit(res.body.id, sender)).rejects.toThrow(
      "tx_failed",
    );
    const tx = getTransaction(res.body.id)!;
    expect(tx.status).toBe("pending_stellar");
    expect(tx.message).toMatch(/tx_failed/);

    // A second attempt must not re-send while the outcome is unknown.
    await expect(fulfillDeposit(res.body.id, sender)).rejects.toThrow(
      /already being submitted/,
    );
    expect(sender.sendPayment).toHaveBeenCalledTimes(1);
  });

  it("refuses to fulfil withdrawals, failed deposits and unknown ids", async () => {
    const { sender } = fakeSender();
    const withdrawal = await initiateWithdrawal({
      asset_code: "XLM",
      amount: "10",
      account: Keypair.random().publicKey(),
    });
    const failed = await deposit();
    updateTransactionStatus(failed.body.id, "failed");

    await expect(fulfillDeposit(withdrawal.id, sender)).rejects.toThrow(
      /not a deposit/,
    );
    await expect(fulfillDeposit(failed.body.id, sender)).rejects.toThrow(
      /is failed/,
    );
    await expect(fulfillDeposit("missing", sender)).rejects.toThrow(
      /not found/,
    );
    expect(sender.sendPayment).not.toHaveBeenCalled();
  });
});
