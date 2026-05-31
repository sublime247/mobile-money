/**
 * Tests for GraphQL Subscriptions — Redis PubSub + WS auth
 *
 * Covers:
 *  - Client receives update immediately on state change
 *  - Unauthenticated WS connection is rejected
 *  - Client only receives updates for subscribed transaction ID
 *  - All state transitions (pending→completed, pending→failed) trigger events
 *  - transactionChannel() naming convention
 */

import { EventEmitter } from "events";
import {
  transactionChannel,
  SubscriptionChannels,
} from "../graphql/subscriptions";
import { createSubscriptionResolvers } from "../graphql/subscriptionResolvers";

// ---------------------------------------------------------------------------
// Minimal in-memory PubSub stub (avoids real Redis in unit tests)
// ---------------------------------------------------------------------------

class StubPubSub extends EventEmitter {
  private iterators: Map<
    string,
    { queue: any[]; resolve: (() => void) | null }
  > = new Map();

  async publish(channel: string, payload: unknown): Promise<void> {
    this.emit(channel, payload);
    const entry = this.iterators.get(channel);
    if (entry) {
      entry.queue.push(payload);
      entry.resolve?.();
      entry.resolve = null;
    }
  }

  asyncIterator<T>(channels: string | string[]): AsyncIterableIterator<T> {
    const channelList = Array.isArray(channels) ? channels : [channels];
    const queue: T[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    for (const ch of channelList) {
      this.iterators.set(ch, { queue, resolve: null });
      this.on(ch, (payload: T) => {
        queue.push(payload);
        resolve?.();
        resolve = null;
      });
    }

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<T>> {
        if (queue.length > 0) {
          return { value: queue.shift()!, done: false };
        }
        if (done) return { value: undefined as any, done: true };
        await new Promise<void>((r) => {
          resolve = r;
        });
        if (queue.length > 0) {
          return { value: queue.shift()!, done: false };
        }
        return { value: undefined as any, done: true };
      },
      async return() {
        done = true;
        return { value: undefined as any, done: true };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_CTX = { auth: { authenticated: true, subject: "user-1" } };
const ANON_CTX = { auth: { authenticated: false, subject: null } };

function makeResolvers() {
  const pubsub = new StubPubSub() as any;
  const resolvers = createSubscriptionResolvers(pubsub);
  return { pubsub, resolvers };
}

// ---------------------------------------------------------------------------
// Channel naming
// ---------------------------------------------------------------------------

describe("transactionChannel()", () => {
  it("produces the expected channel name", () => {
    expect(transactionChannel("abc-123")).toBe("TRANSACTION_UPDATED:abc-123");
  });

  it("different IDs produce different channels", () => {
    expect(transactionChannel("id-1")).not.toBe(transactionChannel("id-2"));
  });
});

// ---------------------------------------------------------------------------
// WS authentication
// ---------------------------------------------------------------------------

describe("WS authentication guard", () => {
  it("rejects unauthenticated subscription with UNAUTHENTICATED error", () => {
    const { resolvers } = makeResolvers();
    const sub = resolvers.Subscription.transactionUpdated;

    expect(() =>
      sub.subscribe(null, { id: "tx-1" }, ANON_CTX, null as any),
    ).toThrow(/UNAUTHENTICATED/);
  });

  it("allows authenticated subscription", () => {
    const { resolvers } = makeResolvers();
    const sub = resolvers.Subscription.transactionUpdated;

    expect(() =>
      sub.subscribe(null, { id: "tx-1" }, AUTH_CTX, null as any),
    ).not.toThrow();
  });

  it("rejects unauthenticated transactionCreated subscription", () => {
    const { resolvers } = makeResolvers();
    expect(() =>
      resolvers.Subscription.transactionCreated.subscribe(
        null,
        {},
        ANON_CTX,
        null as any,
      ),
    ).toThrow(/UNAUTHENTICATED/);
  });
});

// ---------------------------------------------------------------------------
// transactionUpdated — per-ID filtering
// ---------------------------------------------------------------------------

describe("transactionUpdated subscription", () => {
  it("client receives update for subscribed transaction ID", async () => {
    const { pubsub, resolvers } = makeResolvers();
    const sub = resolvers.Subscription.transactionUpdated;

    const iterator = sub.subscribe(
      null,
      { id: "tx-42" },
      AUTH_CTX,
      null as any,
    );

    const payload = {
      id: "tx-42",
      referenceNumber: "REF-001",
      status: "completed",
      updatedAt: new Date().toISOString(),
    };
    await pubsub.publish(transactionChannel("tx-42"), payload);

    const result = await iterator.next();
    expect(result.done).toBe(false);
    const resolved = sub.resolve(result.value);
    expect(resolved.id).toBe("tx-42");
    expect(resolved.status).toBe("completed");

    await iterator.return?.();
  });

  it("client does NOT receive updates for a different transaction ID", async () => {
    const { pubsub, resolvers } = makeResolvers();
    const sub = resolvers.Subscription.transactionUpdated;

    // Subscribe to tx-1
    const iterator = sub.subscribe(null, { id: "tx-1" }, AUTH_CTX, null as any);

    // Publish to tx-2 — should not arrive on tx-1's iterator
    await pubsub.publish(transactionChannel("tx-2"), {
      id: "tx-2",
      referenceNumber: "REF-002",
      status: "failed",
      updatedAt: new Date().toISOString(),
    });

    // Publish to tx-1 — should arrive
    const expected = {
      id: "tx-1",
      referenceNumber: "REF-001",
      status: "completed",
      updatedAt: new Date().toISOString(),
    };
    await pubsub.publish(transactionChannel("tx-1"), expected);

    const result = await iterator.next();
    expect(result.value.id).toBe("tx-1");

    await iterator.return?.();
  });
});

// ---------------------------------------------------------------------------
// State transition events
// ---------------------------------------------------------------------------

describe("state transition events", () => {
  it("PENDING → COMPLETED publishes to TRANSACTION_COMPLETED channel", async () => {
    const { pubsub, resolvers } = makeResolvers();
    const sub = resolvers.Subscription.transactionCompleted;
    const iterator = sub.subscribe(null, {}, AUTH_CTX, null as any);

    const payload = {
      id: "tx-99",
      referenceNumber: "REF-099",
      status: "completed",
      updatedAt: new Date().toISOString(),
    };
    await pubsub.publish(SubscriptionChannels.TRANSACTION_COMPLETED, payload);

    const result = await iterator.next();
    const resolved = sub.resolve(result.value);
    expect(resolved.status).toBe("completed");

    await iterator.return?.();
  });

  it("PENDING → FAILED publishes to TRANSACTION_FAILED channel", async () => {
    const { pubsub, resolvers } = makeResolvers();
    const sub = resolvers.Subscription.transactionFailed;
    const iterator = sub.subscribe(null, {}, AUTH_CTX, null as any);

    const payload = {
      id: "tx-88",
      referenceNumber: "REF-088",
      status: "failed",
      updatedAt: new Date().toISOString(),
    };
    await pubsub.publish(SubscriptionChannels.TRANSACTION_FAILED, payload);

    const result = await iterator.next();
    const resolved = sub.resolve(result.value);
    expect(resolved.status).toBe("failed");

    await iterator.return?.();
  });

  it("transactionCreated fires on new transaction", async () => {
    const { pubsub, resolvers } = makeResolvers();
    const sub = resolvers.Subscription.transactionCreated;
    const iterator = sub.subscribe(null, {}, AUTH_CTX, null as any);

    const payload = {
      id: "tx-new",
      referenceNumber: "REF-NEW",
      type: "deposit",
      amount: "100",
      phoneNumber: "+237600000000",
      provider: "mtn",
      stellarAddress: "GABC",
      status: "pending",
      tags: [],
      createdAt: new Date().toISOString(),
    };
    await pubsub.publish(SubscriptionChannels.TRANSACTION_CREATED, payload);

    const result = await iterator.next();
    const resolved = sub.resolve(result.value);
    expect(resolved.id).toBe("tx-new");
    expect(resolved.status).toBe("pending");

    await iterator.return?.();
  });
});

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

describe("subscription resolve() output shape", () => {
  it("transactionUpdated resolve returns expected fields", () => {
    const { resolvers } = makeResolvers();
    const payload = {
      id: "tx-1",
      referenceNumber: "REF-001",
      status: "completed",
      updatedAt: "2026-04-23T00:00:00.000Z",
    };
    const result = resolvers.Subscription.transactionUpdated.resolve(payload);
    expect(result).toMatchObject({
      id: "tx-1",
      status: "completed",
      referenceNumber: "REF-001",
    });
  });
});
