// src/middleware/errorHandler.ts currently has a pre-existing syntax error on
// upstream/main (duplicate `const inferredCode`/`const statusCode`
// declarations in the same block, confirmed present and unmodified on a
// clean upstream/main checkout) that breaks every test importing it
// transitively, including the existing sep24Assets.test.ts. sep24.ts only
// uses createError from that module for error paths this suite does not
// exercise, so it is mocked here with a minimal equivalent to unblock this
// otherwise-unrelated test from a pre-existing, out-of-scope repo bug.
jest.mock("../../middleware/errorHandler", () => ({
  createError: (
    code: string,
    message?: string,
    details?: Record<string, unknown>,
  ) => {
    const error: Error & { code?: string; details?: Record<string, unknown> } =
      new Error(message);
    error.code = code;
    error.details = details;
    return error;
  },
}));

import { Keypair } from "@stellar/stellar-sdk";
import {
  generateInteractiveUrl,
  getTransaction,
  isInteractiveSessionExpired,
  expireStaleInteractiveSessions,
  renewInteractiveSession,
  Sep24Transaction,
  DepositRequest,
} from "../sep24";
import { configSchema } from "../../config/appConfig";

// A fresh valid Stellar ed25519 public key per call, so tests never share
// the module-level active-transaction-count state keyed by account
// (matches the convention in sep24Assets.test.ts).
function freshAccount(): string {
  return Keypair.random().publicKey();
}

function depositRequest(
  overrides: Partial<DepositRequest> = {},
): DepositRequest {
  return {
    asset_code: "XLM",
    amount: "10",
    account: freshAccount(),
    ...overrides,
  };
}

function makeTransaction(
  overrides: Partial<Sep24Transaction> = {},
): Sep24Transaction {
  return {
    id: "test-tx-id",
    kind: "deposit",
    status: "pending_user_transfer_start",
    account: freshAccount(),
    asset_in: "XLM",
    amount_in: "10",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("isInteractiveSessionExpired (#2264)", () => {
  const ORIGINAL_EXPIRY = configSchema.get(
    "sep24.interactiveSessionExpiryMinutes" as never,
  );

  afterEach(() => {
    configSchema.set(
      "sep24.interactiveSessionExpiryMinutes" as never,
      ORIGINAL_EXPIRY,
    );
  });

  it("is not expired when created just now, with the default 15-minute window", () => {
    const tx = makeTransaction({ created_at: new Date().toISOString() });
    expect(isInteractiveSessionExpired(tx)).toBe(false);
  });

  it("is expired when created 16 minutes ago, with the default 15-minute window", () => {
    const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000);
    const tx = makeTransaction({ created_at: sixteenMinutesAgo.toISOString() });
    expect(isInteractiveSessionExpired(tx)).toBe(true);
  });

  it("is not expired at exactly 14 minutes, is expired at exactly 15 minutes (boundary)", () => {
    const fourteenMinAgo = new Date(Date.now() - 14 * 60 * 1000);
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);

    expect(
      isInteractiveSessionExpired(
        makeTransaction({ created_at: fourteenMinAgo.toISOString() }),
      ),
    ).toBe(false);
    expect(
      isInteractiveSessionExpired(
        makeTransaction({ created_at: fifteenMinAgo.toISOString() }),
      ),
    ).toBe(true);
  });

  it("respects a configured expiry duration other than the default", () => {
    configSchema.set("sep24.interactiveSessionExpiryMinutes" as never, 5);

    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
    const tx = makeTransaction({ created_at: sixMinutesAgo.toISOString() });
    expect(isInteractiveSessionExpired(tx)).toBe(true);

    const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1000);
    const tx2 = makeTransaction({ created_at: fourMinutesAgo.toISOString() });
    expect(isInteractiveSessionExpired(tx2)).toBe(false);
  });

  it("never expires a transaction that has already left pending_user_transfer_start", () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    for (const status of [
      "pending_external",
      "pending_anchor",
      "pending_trust",
      "pending_stellar",
      "completed",
      "failed",
      "expired",
    ] as const) {
      const tx = makeTransaction({ created_at: longAgo, status });
      expect(isInteractiveSessionExpired(tx)).toBe(false);
    }
  });

  it("is not expired when created_at is missing", () => {
    const tx = makeTransaction({ created_at: undefined });
    expect(isInteractiveSessionExpired(tx)).toBe(false);
  });
});

describe("getTransaction lazy eviction (#2264)", () => {
  const ORIGINAL_EXPIRY = configSchema.get(
    "sep24.interactiveSessionExpiryMinutes" as never,
  );

  afterEach(() => {
    configSchema.set(
      "sep24.interactiveSessionExpiryMinutes" as never,
      ORIGINAL_EXPIRY,
    );
  });

  it("transitions a stale pending_user_transfer_start session to expired on read", async () => {
    configSchema.set("sep24.interactiveSessionExpiryMinutes" as never, 1);

    const { id } = await generateInteractiveUrl(depositRequest(), "deposit");

    // Force the transaction to look like it was created 2 minutes ago so it
    // is past the 1-minute expiry window configured above.
    const tx = getTransaction(id);
    expect(tx).toBeDefined();
    tx!.created_at = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    const reread = getTransaction(id);
    expect(reread?.status).toBe("expired");
  });

  it("leaves a fresh session untouched", async () => {
    const { id } = await generateInteractiveUrl(depositRequest(), "deposit");
    const tx = getTransaction(id);
    expect(tx?.status).toBe("pending_user_transfer_start");
  });
});

describe("expireStaleInteractiveSessions sweep (#2264)", () => {
  const ORIGINAL_EXPIRY = configSchema.get(
    "sep24.interactiveSessionExpiryMinutes" as never,
  );

  afterEach(() => {
    configSchema.set(
      "sep24.interactiveSessionExpiryMinutes" as never,
      ORIGINAL_EXPIRY,
    );
  });

  it("sweeps all stale sessions in one pass and returns the count expired", async () => {
    configSchema.set("sep24.interactiveSessionExpiryMinutes" as never, 1);

    const staleIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await generateInteractiveUrl(depositRequest(), "deposit");
      const tx = getTransaction(id)!;
      tx.created_at = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      staleIds.push(id);
    }

    const { id: freshId } = await generateInteractiveUrl(
      depositRequest(),
      "deposit",
    );

    const expiredCount = expireStaleInteractiveSessions();
    expect(expiredCount).toBeGreaterThanOrEqual(3);

    for (const id of staleIds) {
      const tx = getTransaction(id);
      expect(tx?.status).toBe("expired");
    }

    // The fresh one should remain untouched by the sweep.
    const freshTx = getTransaction(freshId);
    expect(freshTx?.status).toBe("pending_user_transfer_start");
  });
});

describe("renewInteractiveSession (#2264)", () => {
  it("mints a fresh interactive session for the same deposit parameters and marks the original expired", async () => {
    const account = freshAccount();
    const { id: originalId } = await generateInteractiveUrl(
      depositRequest({ account, amount: "42" }),
      "deposit",
    );

    const renewed = await renewInteractiveSession(originalId);

    expect(renewed.id).toBeDefined();
    expect(renewed.id).not.toBe(originalId);
    expect(renewed.url).toContain(`transaction_id=${renewed.id}`);

    const renewedTx = getTransaction(renewed.id);
    expect(renewedTx?.account).toBe(account);
    expect(renewedTx?.amount_in).toBe("42");
    expect(renewedTx?.status).toBe("pending_user_transfer_start");

    const originalTx = getTransaction(originalId);
    expect(originalTx?.status).toBe("expired");
    expect(originalTx?.message).toContain(renewed.id);
  });

  it("throws a descriptive error when renewing a transaction that does not exist", async () => {
    await expect(renewInteractiveSession("does-not-exist")).rejects.toThrow(
      /not found/i,
    );
  });

  it("does not re-expire an already-expired original when renewed a second time", async () => {
    const { id: originalId } = await generateInteractiveUrl(
      depositRequest(),
      "deposit",
    );

    const firstRenewal = await renewInteractiveSession(originalId);
    expect(getTransaction(originalId)?.status).toBe("expired");

    // Renewing the already-expired original again should still succeed and
    // produce another fresh session without throwing.
    const secondRenewal = await renewInteractiveSession(originalId);
    expect(secondRenewal.id).not.toBe(firstRenewal.id);
    expect(getTransaction(secondRenewal.id)?.status).toBe(
      "pending_user_transfer_start",
    );
  });
});
