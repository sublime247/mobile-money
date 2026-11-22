import {
  runProviderBalanceAlertCheck,
  startProviderBalanceMonitoringWorker,
  stopProviderBalanceMonitoringWorker,
} from "../../src/jobs/providerBalanceAlertWorker";
import { momoProviderFloatBalance } from "../../src/utils/metrics";

describe("Jobs: Provider Balance Alert Worker (#2275)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stopProviderBalanceMonitoringWorker();
  });

  afterEach(() => {
    stopProviderBalanceMonitoringWorker();
  });

  it("queries MTN, Airtel, and Orange balances and sets Prometheus gauge metrics", async () => {
    const mockMtn = {
      getOperationalBalance: jest.fn().mockResolvedValue({
        success: true,
        data: { availableBalance: 15000, currency: "UGX" },
      }),
    };
    const mockAirtel = {
      getOperationalBalance: jest.fn().mockResolvedValue({
        success: true,
        data: { availableBalance: 50000, currency: "NGN" },
      }),
    };
    const mockOrange = {
      getOperationalBalance: jest.fn().mockResolvedValue({
        success: true,
        data: { balance: 2500000, currency: "GNF" },
      }),
    };

    const spySet = jest.spyOn(momoProviderFloatBalance, "labels");

    const { checked, lowBalances } = await runProviderBalanceAlertCheck({
      providers: {
        mtn: mockMtn,
        airtel: mockAirtel,
        orange: mockOrange,
      },
      thresholds: {
        mtn: 1000,
        airtel: 1000,
        orange: 1000,
      },
    });

    expect(checked).toHaveLength(3);
    expect(lowBalances).toHaveLength(0);

    expect(mockMtn.getOperationalBalance).toHaveBeenCalled();
    expect(mockAirtel.getOperationalBalance).toHaveBeenCalled();
    expect(mockOrange.getOperationalBalance).toHaveBeenCalled();

    expect(spySet).toHaveBeenCalledWith("mtn", "UGX");
    expect(spySet).toHaveBeenCalledWith("airtel", "NGN");
    expect(spySet).toHaveBeenCalledWith("orange", "GNF");
  });

  it("triggers alert notifications when a provider balance drops below threshold", async () => {
    const mockMtn = {
      getOperationalBalance: jest.fn().mockResolvedValue({
        success: true,
        data: { availableBalance: 500, currency: "UGX" }, // below 1000
      }),
    };
    const mockAirtel = {
      getOperationalBalance: jest.fn().mockResolvedValue({
        success: true,
        data: { availableBalance: 20000, currency: "NGN" }, // healthy
      }),
    };
    const mockOrange = {
      getOperationalBalance: jest.fn().mockResolvedValue({
        success: true,
        data: { balance: 100, currency: "GNF" }, // below 1000
      }),
    };

    const alertCallback = jest.fn();

    const { checked, lowBalances } = await runProviderBalanceAlertCheck({
      providers: {
        mtn: mockMtn,
        airtel: mockAirtel,
        orange: mockOrange,
      },
      thresholds: {
        mtn: 1000,
        airtel: 1000,
        orange: 1000,
      },
      onAlert: alertCallback,
    });

    expect(checked).toHaveLength(3);
    expect(lowBalances).toHaveLength(2);
    expect(lowBalances.map((b) => b.provider)).toEqual(["mtn", "orange"]);
    expect(alertCallback).toHaveBeenCalledWith(lowBalances);
  });

  it("handles provider API network errors gracefully without crashing", async () => {
    const mockMtn = {
      getOperationalBalance: jest.fn().mockRejectedValue(new Error("Timeout")),
    };
    const mockAirtel = {
      getOperationalBalance: jest.fn().mockResolvedValue({
        success: false,
        error: "Provider offline",
      }),
    };
    const mockOrange = {
      getOperationalBalance: jest.fn().mockResolvedValue({
        success: true,
        data: { balance: 5000, currency: "GNF" },
      }),
    };

    const { checked, lowBalances } = await runProviderBalanceAlertCheck({
      providers: {
        mtn: mockMtn,
        airtel: mockAirtel,
        orange: mockOrange,
      },
      thresholds: { orange: 1000 },
    });

    expect(checked).toHaveLength(1);
    expect(checked[0].provider).toBe("orange");
    expect(lowBalances).toHaveLength(0);
  });

  it("starts and stops the monitoring worker timer", () => {
    jest.useFakeTimers();
    try {
      startProviderBalanceMonitoringWorker(15 * 60 * 1000);
      stopProviderBalanceMonitoringWorker();
    } finally {
      jest.useRealTimers();
    }
  });
});
