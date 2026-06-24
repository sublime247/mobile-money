import * as StellarSdk from "stellar-sdk";
import { ChannelAccountPool, isSequenceMismatchError } from "../pool";
import {
  ChannelAccountModel,
  ChannelAccountRow,
  ChannelAccountStatus,
} from "../../models/channelAccount";
import * as stellarConfig from "../../config/stellar";

jest.mock("../../config/stellar", () => ({
  ...jest.requireActual("../../config/stellar"),
  getStellarServer: jest.fn(),
}));

function makeChannelAccounts(count: number): ChannelAccountRow[] {
  return Array.from({ length: count }, (_, i) => {
    const kp = StellarSdk.Keypair.random();
    return {
      id: `uuid-${i}`,
      publicKey: kp.publicKey(),
      encryptedKey: "fake-encrypted",
      status: "idle" as ChannelAccountStatus,
      sequence: "100",
      errorCount: 0,
      lockedAt: null,
      disabledAt: null,
      lastUsedAt: null,
      fundedAt: null,
      balance: "10",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });
}

describe("ChannelAccountPool", () => {
  let mockServer: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockServer = {
      loadAccount: jest.fn().mockResolvedValue({
        sequenceNumber: () => "100",
        balances: [{ asset_type: "native", balance: "10" }],
      }),
      submitTransaction: jest.fn().mockResolvedValue({ hash: "ok-hash" }),
    };

    (stellarConfig.getStellarServer as jest.Mock).mockReturnValue(mockServer);
  });

  it("limits concurrent usage while serving 50+ requests", async () => {
    const channels = makeChannelAccounts(5);

    const mockModel = {
      countAll: jest.fn().mockResolvedValue(5),
      findAll: jest.fn().mockResolvedValue([...channels]), // Added to satisfy initialize() loop
      recoverStale: jest.fn().mockResolvedValue(0),
      updateSequence: jest.fn().mockResolvedValue(undefined),
      updateBalance: jest.fn().mockResolvedValue(undefined),
      decryptSecretKey: jest.fn().mockImplementation((row) => {
        return StellarSdk.Keypair.random().secret();
      }),
      acquireIdle: jest.fn().mockImplementation(async () => {
        const available = channels.find((c) => c.status === "idle");
        if (available) {
          available.status = "busy";
          return available;
        }
        return null;
      }),
      release: jest.fn().mockImplementation(async (id, success, opts) => {
        const row = channels.find((c) => c.id === id);
        if (row) {
          row.status = "idle";
          if (success && opts?.newSequence) row.sequence = opts.newSequence;
        }
        return row;
      }),
    } as unknown as ChannelAccountModel;

    const pool = new ChannelAccountPool({}, mockModel);
    await pool.initialize();

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
    expect(mockModel.acquireIdle).toHaveBeenCalled();
    expect(mockModel.release).toHaveBeenCalled();

    // Clean up interval clocks
    await pool.shutdown();
  });

  it("resyncs and retries on sequence mismatch", async () => {
    const channel = makeChannelAccounts(1)[0];

    const mockModel = {
      countAll: jest.fn().mockResolvedValue(1),
      findAll: jest.fn().mockResolvedValue([{ ...channel }]), // Added to satisfy initialize() loop
      recoverStale: jest.fn().mockResolvedValue(0),
      decryptSecretKey: jest
        .fn()
        .mockReturnValue(StellarSdk.Keypair.random().secret()),
      acquireIdle: jest
        .fn()
        .mockResolvedValueOnce({ ...channel })
        .mockResolvedValue(null),
      release: jest.fn().mockResolvedValue({}),
      findByPublicKey: jest.fn().mockResolvedValue(channel),
      updateSequence: jest.fn().mockResolvedValue(undefined),
      updateBalance: jest.fn().mockResolvedValue(undefined),
    } as unknown as ChannelAccountModel;

    // Call 1: initialize() startup verification pass
    // Call 2: submitWithChannel() internal resync sequence pass
    mockServer.loadAccount
      .mockResolvedValueOnce({
        sequenceNumber: () => "100",
        balances: [{ asset_type: "native", balance: "10" }],
      })
      .mockResolvedValueOnce({
        sequenceNumber: () => "150",
        balances: [{ asset_type: "native", balance: "10" }],
      });

    mockServer.submitTransaction
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

    const pool = new ChannelAccountPool({}, mockModel);
    (pool as any)._maxSequenceMismatchRetries = 1;
    await pool.initialize();

    const sequences: string[] = [];
    const result = await pool.submitWithChannel(async ({ currentSequence }) => {
      sequences.push(currentSequence);
      return {} as StellarSdk.Transaction;
    });

    expect(result).toEqual({ hash: "ok-hash" });
    expect(sequences).toEqual(["100", "150"]);
    expect(mockServer.submitTransaction).toHaveBeenCalledTimes(2);
    expect(mockServer.loadAccount).toHaveBeenCalledTimes(2); // Initial boot + emergency sync
    expect(mockModel.updateSequence).toHaveBeenCalledWith(channel.id, "150");

    await pool.shutdown();
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
