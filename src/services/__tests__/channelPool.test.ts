import * as StellarSdk from "@stellar/stellar-sdk";
import {
  ChannelAccountPool,
  ChannelHorizon,
  ChannelLease,
  ChannelPoolExhaustedError,
  InMemoryChannelLeaseStore,
  RedisChannelLeaseStore,
} from "../channelPool";

const PASSPHRASE = StellarSdk.Networks.TESTNET;

/**
 * Minimal Horizon double that enforces Stellar's sequence rule: a
 * transaction is accepted only if its sequence is the source's current
 * sequence + 1, otherwise it fails with tx_bad_seq.
 */
class FakeHorizon implements ChannelHorizon {
  sequences = new Map<string, bigint>();
  balances = new Map<string, string>();
  submitted: StellarSdk.Transaction[] = [];
  loads: string[] = [];
  latencyMs = 0;

  add(publicKey: string, sequence = 100n, balance = "50.0000000") {
    this.sequences.set(publicKey, sequence);
    this.balances.set(publicKey, balance);
  }

  async loadAccount(publicKey: string) {
    this.loads.push(publicKey);
    const seq = this.sequences.get(publicKey);
    if (seq === undefined) throw new Error(`unknown account ${publicKey}`);
    return {
      sequenceNumber: () => seq.toString(),
      balances: [
        { asset_type: "native", balance: this.balances.get(publicKey)! },
      ],
    } as unknown as StellarSdk.Horizon.AccountResponse;
  }

  async submitTransaction(
    tx: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction,
  ) {
    const inner = tx as StellarSdk.Transaction;
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const current = this.sequences.get(inner.source)!;
    if (BigInt(inner.sequence) !== current + 1n) {
      throw Object.assign(new Error("Transaction failed: tx_bad_seq"), {
        response: {
          data: { extras: { result_codes: { transaction: "tx_bad_seq" } } },
        },
      });
    }
    this.sequences.set(inner.source, current + 1n);
    this.submitted.push(inner);
    return {
      hash: inner.hash().toString("hex"),
      ledger: 1,
    } as StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse;
  }
}

const issuer = StellarSdk.Keypair.random();
const destination = StellarSdk.Keypair.random().publicKey();

function channels(n: number) {
  return Array.from({ length: n }, () => {
    const kp = StellarSdk.Keypair.random();
    return { publicKey: kp.publicKey(), secretKey: kp.secret() };
  });
}

function makePool(
  horizon: FakeHorizon,
  accounts = channels(3),
  overrides: Partial<ConstructorParameters<typeof ChannelAccountPool>[0]> = {},
) {
  for (const a of accounts) {
    if (!horizon.sequences.has(a.publicKey)) horizon.add(a.publicKey);
  }
  return new ChannelAccountPool({
    accounts,
    horizon,
    networkPassphrase: PASSPHRASE,
    pollIntervalMs: 2,
    acquireTimeoutMs: 2_000,
    ...overrides,
  });
}

/** Payment from the issuer, with the leased channel as transaction source. */
function pay(horizon: FakeHorizon, track?: (lease: ChannelLease) => void) {
  return async (lease: ChannelLease) => {
    track?.(lease);
    const tx = new StellarSdk.TransactionBuilder(lease.account, {
      fee: "100",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination,
          asset: StellarSdk.Asset.native(),
          amount: "1",
          source: issuer.publicKey(),
        }),
      )
      .setTimeout(30)
      .build();
    tx.sign(issuer, lease.keypair);
    return horizon.submitTransaction(tx);
  };
}

describe("ChannelAccountPool", () => {
  describe("construction", () => {
    it("rejects an empty pool", () => {
      expect(
        () =>
          new ChannelAccountPool({ accounts: [], horizon: new FakeHorizon() }),
      ).toThrow(/at least one/);
    });

    it("rejects a secret that does not match its public key", () => {
      const [a, b] = channels(2);
      expect(
        () =>
          new ChannelAccountPool({
            accounts: [{ publicKey: a.publicKey, secretKey: b.secretKey }],
            horizon: new FakeHorizon(),
          }),
      ).toThrow(/does not match/);
    });

    it("rejects duplicate channels", () => {
      const [a] = channels(1);
      expect(
        () =>
          new ChannelAccountPool({
            accounts: [a, a],
            horizon: new FakeHorizon(),
          }),
      ).toThrow(/Duplicate/);
    });
  });

  describe("leasing", () => {
    it("submits many concurrent payments without a sequence collision", async () => {
      const horizon = new FakeHorizon();
      horizon.latencyMs = 5;
      const pool = makePool(horizon, channels(3));

      const results = await Promise.all(
        Array.from({ length: 30 }, () => pool.withChannel(pay(horizon))),
      );

      expect(results).toHaveLength(30);
      expect(horizon.submitted).toHaveLength(30);
      // Every channel advanced by exactly the number of txs it carried.
      for (const publicKey of pool.publicKeys) {
        const used = horizon.submitted.filter((t) => t.source === publicKey);
        expect(horizon.sequences.get(publicKey)).toBe(
          100n + BigInt(used.length),
        );
      }
      expect(pool.getStats()).toEqual({
        total: 3,
        available: 3,
        leased: 0,
        waiting: 0,
      });
    });

    it("never leases one channel to two callers at once", async () => {
      const horizon = new FakeHorizon();
      horizon.latencyMs = 3;
      const pool = makePool(horizon, channels(2));
      const inUse = new Set<string>();
      let overlap = false;

      await Promise.all(
        Array.from({ length: 12 }, () =>
          pool.withChannel(async (lease) => {
            if (inUse.has(lease.publicKey)) overlap = true;
            inUse.add(lease.publicKey);
            try {
              return await pay(horizon)(lease);
            } finally {
              inUse.delete(lease.publicKey);
            }
          }),
        ),
      );

      expect(overlap).toBe(false);
    });

    it("coordinates channels across replicas through the shared lease store", async () => {
      const horizon = new FakeHorizon();
      horizon.latencyMs = 3;
      const accounts = channels(2);
      const store = new InMemoryChannelLeaseStore();
      const replicaA = makePool(horizon, accounts, { leaseStore: store });
      const replicaB = makePool(horizon, accounts, { leaseStore: store });

      await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          (i % 2 ? replicaA : replicaB).withChannel(pay(horizon)),
        ),
      );

      // tx_bad_seq would have been thrown on any cross-replica collision.
      expect(horizon.submitted).toHaveLength(16);
    });

    it("caches sequences so Horizon is only asked once per channel", async () => {
      const horizon = new FakeHorizon();
      const pool = makePool(horizon, channels(1));

      for (let i = 0; i < 5; i++) await pool.withChannel(pay(horizon));

      expect(horizon.loads).toHaveLength(1);
    });

    it("serves queued callers in FIFO order", async () => {
      const horizon = new FakeHorizon();
      const pool = makePool(horizon, channels(1));
      const order: number[] = [];
      let unblock!: () => void;
      const gate = new Promise<void>((r) => (unblock = r));

      const first = pool.withChannel(async () => {
        await gate;
        order.push(0);
      });
      const queued = [1, 2, 3].map((n) =>
        pool.withChannel(async () => {
          order.push(n);
        }),
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(pool.getStats().waiting).toBe(3);

      unblock();
      await Promise.all([first, ...queued]);

      expect(order).toEqual([0, 1, 2, 3]);
    });

    it("times out when no channel frees up", async () => {
      const horizon = new FakeHorizon();
      const pool = makePool(horizon, channels(1), { acquireTimeoutMs: 30 });
      let unblock!: () => void;
      const held = pool.withChannel(
        () => new Promise<void>((r) => (unblock = r)),
      );
      await new Promise((r) => setTimeout(r, 5));

      await expect(pool.withChannel(pay(horizon))).rejects.toBeInstanceOf(
        ChannelPoolExhaustedError,
      );

      unblock();
      await held;
      expect(pool.getStats().waiting).toBe(0);
    });

    it("skips a channel another replica holds", async () => {
      const horizon = new FakeHorizon();
      const accounts = channels(2);
      const store = new InMemoryChannelLeaseStore();
      await store.tryLease(accounts[0].publicKey, "other-replica", 60_000);
      const pool = makePool(horizon, accounts, { leaseStore: store });

      const used: string[] = [];
      await pool.withChannel(pay(horizon, (l) => used.push(l.publicKey)));
      await pool.withChannel(pay(horizon, (l) => used.push(l.publicKey)));

      expect(used).toEqual([accounts[1].publicKey, accounts[1].publicKey]);
    });
  });

  describe("sequence recovery", () => {
    it("reloads the sequence and retries on tx_bad_seq", async () => {
      const horizon = new FakeHorizon();
      const [account] = channels(1);
      const pool = makePool(horizon, [account]);
      await pool.withChannel(pay(horizon)); // caches seq 101

      // Someone else used the channel out-of-band.
      horizon.sequences.set(account.publicKey, 500n);

      await pool.withChannel(pay(horizon));

      expect(horizon.sequences.get(account.publicKey)).toBe(501n);
      expect(horizon.loads).toHaveLength(2);
    });

    it("gives up after maxSequenceRetries", async () => {
      const horizon = new FakeHorizon();
      const pool = makePool(horizon, channels(1), { maxSequenceRetries: 2 });
      const alwaysStale = async (lease: ChannelLease) => {
        // Another party keeps moving the sequence under us.
        horizon.sequences.set(
          lease.publicKey,
          horizon.sequences.get(lease.publicKey)! + 10n,
        );
        return pay(horizon)(lease);
      };

      await expect(pool.withChannel(alwaysStale)).rejects.toThrow(/tx_bad_seq/);
    });

    it("releases the channel and drops the cached sequence on other errors", async () => {
      const horizon = new FakeHorizon();
      const [account] = channels(1);
      const pool = makePool(horizon, [account]);
      await pool.withChannel(pay(horizon));

      await expect(
        pool.withChannel(async (lease) => {
          new StellarSdk.TransactionBuilder(lease.account, {
            fee: "100",
            networkPassphrase: PASSPHRASE,
          })
            .setTimeout(30)
            .addOperation(StellarSdk.Operation.bumpSequence({ bumpTo: "0" }))
            .build();
          throw new Error("timeout: outcome unknown");
        }),
      ).rejects.toThrow("timeout");

      expect(pool.getStats().available).toBe(1);
      await pool.withChannel(pay(horizon));
      expect(horizon.loads).toHaveLength(2); // reloaded, not trusted
    });

    it("keeps the cached sequence when nothing was built", async () => {
      const horizon = new FakeHorizon();
      const pool = makePool(horizon, channels(1));
      await pool.withChannel(pay(horizon));

      await expect(
        pool.withChannel(async () => {
          throw new Error("validation failed");
        }),
      ).rejects.toThrow("validation failed");
      await pool.withChannel(pay(horizon));

      expect(horizon.loads).toHaveLength(1);
    });
  });

  describe("replenishment", () => {
    const funder = StellarSdk.Keypair.random();

    it("tops low channels up to the target in one funder transaction", async () => {
      const horizon = new FakeHorizon();
      horizon.add(funder.publicKey(), 1n, "10000");
      const [low, ok, empty] = channels(3);
      horizon.add(low.publicKey, 100n, "2.5000000");
      horizon.add(ok.publicKey, 100n, "15.0000000");
      horizon.add(empty.publicKey, 100n, "0");
      const pool = makePool(horizon, [low, ok, empty], {
        funder,
        minBalanceXlm: 5,
        targetBalanceXlm: 20,
      });

      const result = await pool.replenish();

      expect(result).toEqual([
        {
          publicKey: low.publicKey,
          previousBalance: "2.5000000",
          toppedUpBy: "17.5000000",
        },
        {
          publicKey: empty.publicKey,
          previousBalance: "0.0000000",
          toppedUpBy: "20.0000000",
        },
      ]);
      expect(horizon.submitted).toHaveLength(1);
      const tx = horizon.submitted[0];
      expect(tx.source).toBe(funder.publicKey());
      expect(
        tx.operations.map((op) => [
          (op as StellarSdk.Operation.Payment).destination,
          (op as StellarSdk.Operation.Payment).amount,
        ]),
      ).toEqual([
        [low.publicKey, "17.5000000"],
        [empty.publicKey, "20.0000000"],
      ]);
    });

    it("does nothing when every channel is funded", async () => {
      const horizon = new FakeHorizon();
      horizon.add(funder.publicKey(), 1n, "10000");
      const pool = makePool(horizon, channels(2), { funder });

      expect(await pool.replenish()).toEqual([]);
      expect(horizon.submitted).toHaveLength(0);
    });

    it("is disabled without a funder", async () => {
      const horizon = new FakeHorizon();
      const [low] = channels(1);
      horizon.add(low.publicKey, 100n, "0");
      const pool = makePool(horizon, [low]);

      expect(await pool.replenish()).toEqual([]);
    });

    it("lets only one replica replenish at a time", async () => {
      const horizon = new FakeHorizon();
      horizon.add(funder.publicKey(), 1n, "10000");
      const [low] = channels(1);
      horizon.add(low.publicKey, 100n, "1");
      const store = new InMemoryChannelLeaseStore();
      const a = makePool(horizon, [low], { funder, leaseStore: store });
      const b = makePool(horizon, [low], { funder, leaseStore: store });

      const [ra, rb] = await Promise.all([a.replenish(), b.replenish()]);

      expect(ra.length + rb.length).toBe(1);
      expect(horizon.submitted).toHaveLength(1);
    });

    it("rejects a target at or below the minimum", () => {
      expect(() =>
        makePool(new FakeHorizon(), channels(1), {
          minBalanceXlm: 10,
          targetBalanceXlm: 10,
        }),
      ).toThrow(/targetBalanceXlm/);
    });
  });
});

describe("InMemoryChannelLeaseStore", () => {
  it("expires leases after their TTL", async () => {
    let now = 0;
    const store = new InMemoryChannelLeaseStore(() => now);

    expect(await store.tryLease("c", "a", 100)).toBe(true);
    expect(await store.tryLease("c", "b", 100)).toBe(false);
    now = 101;
    expect(await store.tryLease("c", "b", 100)).toBe(true);
  });

  it("only lets the owner release", async () => {
    const store = new InMemoryChannelLeaseStore();
    await store.tryLease("c", "a", 1_000);

    await store.release("c", "intruder");
    expect(await store.tryLease("c", "b", 1_000)).toBe(false);

    await store.release("c", "a");
    expect(await store.tryLease("c", "b", 1_000)).toBe(true);
  });
});

describe("RedisChannelLeaseStore", () => {
  it("falls back to in-process leasing while Redis is disconnected", async () => {
    const store = new RedisChannelLeaseStore();

    expect(await store.tryLease("c", "a", 1_000)).toBe(true);
    expect(await store.tryLease("c", "b", 1_000)).toBe(false);
    await store.setSequence("G1", "42");
    expect(await store.getSequence("G1")).toBe("42");
  });
});
