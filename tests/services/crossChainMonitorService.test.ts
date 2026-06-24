import { CrossChainMonitorService, ChainAssetSnapshot } from "../../src/services/crossChainMonitorService";
import * as stellarConfig from "../../src/config/stellar";
import * as metrics from "../../src/utils/metrics";

jest.mock("../../src/config/stellar");
jest.mock("../../src/services/mobilemoney/providers/mtn", () => ({
  MTNProvider: jest.fn().mockImplementation(() => ({
    getOperationalBalance: jest.fn().mockResolvedValue({
      success: true,
      data: { availableBalance: 0, currency: "XAF" },
    }),
  })),
}));
jest.mock("../../src/services/mobilemoney/providers/airtel", () => ({
  AirtelService: jest.fn().mockImplementation(() => ({
    getOperationalBalance: jest.fn().mockResolvedValue({
      success: true,
      data: { availableBalance: 0, currency: "XAF" },
    }),
  })),
}));
jest.mock("../../src/utils/metrics", () => ({
  crossChainBalanceGauge: { set: jest.fn() },
  crossChainAnomalyTotal: { inc: jest.fn() },
}));

const mockLoadAccount = jest.fn();
jest.mocked(stellarConfig.getStellarServer).mockReturnValue({
  loadAccount: mockLoadAccount,
} as any);

describe("CrossChainMonitorService", () => {
  let service: CrossChainMonitorService;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset singleton
    (CrossChainMonitorService as any).instance = undefined;
    service = CrossChainMonitorService.getInstance();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
    delete process.env.CROSS_CHAIN_STELLAR_ADDRESSES;
    delete process.env.HOT_WALLET_PUBLIC_KEYS;
    delete process.env.CROSS_CHAIN_DROP_THRESHOLD_PCT;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe("getInstance", () => {
    it("returns the same instance on repeated calls", () => {
      const a = CrossChainMonitorService.getInstance();
      const b = CrossChainMonitorService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe("getLastSnapshot", () => {
    it("returns empty array before any snapshot", () => {
      expect(service.getLastSnapshot()).toEqual([]);
    });
  });

  describe("snapshot - mobile money providers", () => {
    it("includes MTN, Airtel, and Orange balances with zero balance stubs", async () => {
      const snapshots = await service.snapshot();

      const chains = snapshots.map((s) => s.chain);
      expect(chains).toContain("mtn");
      expect(chains).toContain("airtel");
      expect(chains).toContain("orange");
    });

    it("sets balance to '0' for provider stubs", async () => {
      const snapshots = await service.snapshot();
      const providerSnaps = snapshots.filter((s) =>
        ["mtn", "airtel", "orange"].includes(s.chain),
      );
      for (const snap of providerSnaps) {
        expect(snap.balance).toBe("0");
        expect(snap.asset).toBe("XAF");
      }
    });

    it("sets capturedAt to a recent date", async () => {
      const before = new Date();
      const snapshots = await service.snapshot();
      const after = new Date();
      for (const snap of snapshots) {
        expect(snap.capturedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(snap.capturedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      }
    });
  });

  describe("snapshot - Stellar balances", () => {
    it("fetches XLM and custom asset balances for configured addresses", async () => {
      process.env.CROSS_CHAIN_STELLAR_ADDRESSES = "GABC123";
      mockLoadAccount.mockResolvedValue({
        balances: [
          { asset_type: "native", balance: "100.5000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "50.0000000" },
        ],
      });

      const snapshots = await service.snapshot();
      const stellarSnaps = snapshots.filter((s) => s.chain === "stellar");

      expect(stellarSnaps).toHaveLength(2);
      expect(stellarSnaps.find((s) => s.asset === "XLM")).toBeDefined();
      expect(stellarSnaps.find((s) => s.asset === "USDC")).toBeDefined();
      expect(stellarSnaps[0].address).toBe("GABC123");
    });

    it("reads addresses from HOT_WALLET_PUBLIC_KEYS env var", async () => {
      process.env.HOT_WALLET_PUBLIC_KEYS = "GHOT1,GHOT2";
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: "native", balance: "10.0000000" }],
      });

      const snapshots = await service.snapshot();
      const stellarSnaps = snapshots.filter((s) => s.chain === "stellar");

      expect(stellarSnaps).toHaveLength(2);
      expect(stellarSnaps.map((s) => s.address)).toEqual(
        expect.arrayContaining(["GHOT1", "GHOT2"]),
      );
    });

    it("merges CROSS_CHAIN_STELLAR_ADDRESSES and HOT_WALLET_PUBLIC_KEYS", async () => {
      process.env.CROSS_CHAIN_STELLAR_ADDRESSES = "GEXTRA";
      process.env.HOT_WALLET_PUBLIC_KEYS = "GHOT";
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: "native", balance: "1.0000000" }],
      });

      const snapshots = await service.snapshot();
      const addresses = snapshots
        .filter((s) => s.chain === "stellar")
        .map((s) => s.address);

      expect(addresses).toContain("GEXTRA");
      expect(addresses).toContain("GHOT");
    });

    it("skips failed Stellar account loads and logs error", async () => {
      process.env.CROSS_CHAIN_STELLAR_ADDRESSES = "GBAD";
      mockLoadAccount.mockRejectedValue(new Error("Account not found"));

      const snapshots = await service.snapshot();
      const stellarSnaps = snapshots.filter((s) => s.chain === "stellar");

      expect(stellarSnaps).toHaveLength(0);
    });

    it("returns only provider snapshots when no Stellar addresses configured", async () => {
      const snapshots = await service.snapshot();
      const stellarSnaps = snapshots.filter((s) => s.chain === "stellar");
      expect(stellarSnaps).toHaveLength(0);
    });
  });

  describe("snapshot - Prometheus metrics", () => {
    it("calls crossChainBalanceGauge.set for each snapshot", async () => {
      process.env.CROSS_CHAIN_STELLAR_ADDRESSES = "GABC";
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: "native", balance: "42.0000000" }],
      });

      const snapshots = await service.snapshot();

      expect(metrics.crossChainBalanceGauge.set).toHaveBeenCalledTimes(
        snapshots.length,
      );
      expect(metrics.crossChainBalanceGauge.set).toHaveBeenCalledWith(
        { chain: "stellar", asset: "XLM", address: "GABC" },
        42,
      );
    });
  });

  describe("snapshot - anomaly detection", () => {
    it("increments anomaly counter when balance drops beyond threshold", async () => {
      process.env.CROSS_CHAIN_STELLAR_ADDRESSES = "GABC";
      process.env.CROSS_CHAIN_DROP_THRESHOLD_PCT = "20";

      // First snapshot: balance 100
      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "100.0000000" }],
      });
      await service.snapshot();

      // Second snapshot: balance 70 (30% drop > 20% threshold)
      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "70.0000000" }],
      });
      await service.snapshot();

      expect(metrics.crossChainAnomalyTotal.inc).toHaveBeenCalledWith({
        chain: "stellar",
        asset: "XLM",
        reason: "balance_drop",
      });
    });

    it("does not flag anomaly when drop is within threshold", async () => {
      process.env.CROSS_CHAIN_STELLAR_ADDRESSES = "GABC";
      process.env.CROSS_CHAIN_DROP_THRESHOLD_PCT = "20";

      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "100.0000000" }],
      });
      await service.snapshot();

      // 10% drop — below 20% threshold
      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "90.0000000" }],
      });
      await service.snapshot();

      expect(metrics.crossChainAnomalyTotal.inc).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it("does not flag anomaly on first snapshot (no previous data)", async () => {
      process.env.CROSS_CHAIN_STELLAR_ADDRESSES = "GABC";
      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "100.0000000" }],
      });

      await service.snapshot();

      expect(metrics.crossChainAnomalyTotal.inc).not.toHaveBeenCalled();
    });

    it("does not flag anomaly when previous balance was zero", async () => {
      process.env.CROSS_CHAIN_STELLAR_ADDRESSES = "GABC";

      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "0.0000000" }],
      });
      await service.snapshot();

      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "0.0000000" }],
      });
      await service.snapshot();

      expect(metrics.crossChainAnomalyTotal.inc).not.toHaveBeenCalled();
    });

    it("uses default threshold of 20% when env var is not set", async () => {
      process.env.CROSS_CHAIN_STELLAR_ADDRESSES = "GABC";

      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "100.0000000" }],
      });
      await service.snapshot();

      // 19% drop — should NOT trigger with default 20% threshold
      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "81.0000000" }],
      });
      await service.snapshot();

      expect(metrics.crossChainAnomalyTotal.inc).not.toHaveBeenCalled();
    });

    it("uses custom threshold from CROSS_CHAIN_DROP_THRESHOLD_PCT", async () => {
      process.env.CROSS_CHAIN_STELLAR_ADDRESSES = "GABC";
      process.env.CROSS_CHAIN_DROP_THRESHOLD_PCT = "10";

      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "100.0000000" }],
      });
      await service.snapshot();

      // 15% drop — triggers with 10% threshold
      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "85.0000000" }],
      });
      await service.snapshot();

      expect(metrics.crossChainAnomalyTotal.inc).toHaveBeenCalledWith({
        chain: "stellar",
        asset: "XLM",
        reason: "balance_drop",
      });
    });

    it("falls back to 20% threshold when CROSS_CHAIN_DROP_THRESHOLD_PCT is invalid", async () => {
      process.env.CROSS_CHAIN_STELLAR_ADDRESSES = "GABC";
      process.env.CROSS_CHAIN_DROP_THRESHOLD_PCT = "not-a-number";

      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "100.0000000" }],
      });
      await service.snapshot();

      // 19% drop — should NOT trigger with fallback 20% threshold
      mockLoadAccount.mockResolvedValueOnce({
        balances: [{ asset_type: "native", balance: "81.0000000" }],
      });
      await service.snapshot();

      expect(metrics.crossChainAnomalyTotal.inc).not.toHaveBeenCalled();
    });
  });

  describe("snapshot - state persistence", () => {
    it("updates getLastSnapshot after each call", async () => {
      process.env.CROSS_CHAIN_STELLAR_ADDRESSES = "GABC";
      mockLoadAccount.mockResolvedValue({
        balances: [{ asset_type: "native", balance: "5.0000000" }],
      });

      expect(service.getLastSnapshot()).toHaveLength(0);
      const snapshots = await service.snapshot();
      expect(service.getLastSnapshot()).toEqual(snapshots);
    });

    it("returns snapshot data with correct shape", async () => {
      const snapshots = await service.snapshot();
      for (const snap of snapshots) {
        expect(snap).toHaveProperty("chain");
        expect(snap).toHaveProperty("asset");
        expect(snap).toHaveProperty("address");
        expect(snap).toHaveProperty("balance");
        expect(snap).toHaveProperty("capturedAt");
        expect(snap.capturedAt).toBeInstanceOf(Date);
      }
    });
  });
});
