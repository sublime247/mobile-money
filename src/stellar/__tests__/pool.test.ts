import * as StellarSdk from "stellar-sdk";
import { ChannelAccountPool, isSequenceMismatchError } from "../pool";

function makeChannelAccounts(count: number) {
  return Array.from({ length: count }, () => {
    const kp = StellarSdk.Keypair.random();
    return {
      publicKey: kp.publicKey(),
      secret: kp.secret(),
    };
  });
}

describe("ChannelAccountPool", () => {
  it("limits concurrent usage to pool size while serving 50+ requests", async () => {
    const channels = makeChannelAccounts(5);
    const server = {
      loadAccount: jest.fn(async () => ({ sequence: "100" })),
      submitTransaction: jest.fn(),
    } as unknown as StellarSdk.Horizon.Server;

    const pool = new ChannelAccountPool({
      channelAccounts: channels,
      server,
    });

    let active = 0;
    let maxActive = 0;

    const jobs = Array.from({ length: 50 }, async (_, index) =>
      pool.withAccount(async (lease) => {
        expect(lease.publicKey.length).toBeGreaterThan(0);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) =>
          setTimeout(resolve, index % 2 === 0 ? 5 : 2),
        );
        active -= 1;
      }),
    );

    await Promise.all(jobs);

    expect(maxActive).toBeLessThanOrEqual(5);
    expect(pool.getAvailableCount()).toBe(5);
    expect(pool.getInUseCount()).toBe(0);
  });

  it("resyncs and retries on sequence mismatch", async () => {
    const channel = makeChannelAccounts(1)[0];
    const loadAccount = jest
      .fn()
      .mockResolvedValueOnce({ sequence: "100" })
      .mockResolvedValueOnce({ sequence: "150" });
    const submitTransaction = jest
      .fn()
      .mockRejectedValueOnce({
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: "tx_bad_seq",
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({ hash: "ok-hash" });

    const pool = new ChannelAccountPool({
      channelAccounts: [channel],
      server: {
        loadAccount,
        submitTransaction,
      } as unknown as StellarSdk.Horizon.Server,
      maxSequenceMismatchRetries: 1,
    });

    const sequences: string[] = [];
    const result = await pool.submitWithChannel(async ({ currentSequence }) => {
      sequences.push(currentSequence);
      return {} as StellarSdk.Transaction;
    });

    expect(result).toEqual({ hash: "ok-hash" });
    expect(sequences).toEqual(["100", "150"]);
    expect(submitTransaction).toHaveBeenCalledTimes(2);
    expect(loadAccount).toHaveBeenCalledTimes(2);
    expect(pool.getAvailableCount()).toBe(1);
  });

  it("detects common sequence mismatch error shapes", () => {
    expect(
      isSequenceMismatchError({
        message: "Transaction Failed: tx_bad_seq",
      }),
    ).toBe(true);

    expect(
      isSequenceMismatchError({
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: "tx_bad_seq",
              },
            },
          },
        },
      }),
    ).toBe(true);

    expect(isSequenceMismatchError(new Error("some other error"))).toBe(false);
  });
});
