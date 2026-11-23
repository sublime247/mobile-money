const mockPingProvider = jest.fn();
const mockMtnBalance = jest.fn();
const mockAirtelBalance = jest.fn();

const mockProviders = ["mtn", "airtel", "orange", "wave_senegal"].map(
  (name) => ({
    name,
    pingUrl: `https://${name}.example/ping`,
    timeoutMs: 1000,
  }),
);

jest.mock("../../src/services/mobilemoney/providers/healthCheck", () => ({
  DEFAULT_PROVIDERS: mockProviders,
  pingProvider: mockPingProvider,
}));

jest.mock("../../src/services/mobilemoney/providers/mtn", () => ({
  MTNProvider: jest.fn().mockImplementation(() => ({
    getOperationalBalance: mockMtnBalance,
  })),
}));

jest.mock("../../src/services/mobilemoney/providers/airtel", () => ({
  AirtelService: jest.fn().mockImplementation(() => ({
    getOperationalBalance: mockAirtelBalance,
  })),
}));

import { runCli, showHelp } from "../../src/scripts/momo-cli";
import { formatTable } from "../../src/utils/cli";

type PingOutcome = { status: "up" | "down"; responseTime: number | null };

function mockPings(outcomes: Record<string, PingOutcome>): void {
  mockPingProvider.mockImplementation(async (config: { name: string }) => {
    return outcomes[config.name];
  });
}

const ALL_UP: Record<string, PingOutcome> = {
  mtn: { status: "up", responseTime: 120 },
  airtel: { status: "up", responseTime: 85 },
  orange: { status: "up", responseTime: 310 },
  wave_senegal: { status: "up", responseTime: 45 },
};

describe("momo-cli provider:health", () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  const originalPrimary = process.env.MOMO_PRIMARY_PROVIDERS;

  const output = () =>
    logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");

  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
    delete process.env.MOMO_PRIMARY_PROVIDERS;

    mockMtnBalance.mockResolvedValue({
      success: true,
      data: { availableBalance: 1500000.5, currency: "XAF" },
    });
    mockAirtelBalance.mockResolvedValue({
      success: true,
      data: { availableBalance: 250000, currency: "XAF" },
    });

    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = undefined;
    if (originalPrimary === undefined) {
      delete process.env.MOMO_PRIMARY_PROVIDERS;
    } else {
      process.env.MOMO_PRIMARY_PROVIDERS = originalPrimary;
    }
  });

  it("lists provider:health in the help output", () => {
    showHelp();
    expect(output()).toContain("provider:health");
  });

  it("queries every registered provider in parallel", async () => {
    const resolvers: Array<() => void> = [];
    mockPingProvider.mockImplementation(
      (config: { name: string }) =>
        new Promise((resolve) => {
          resolvers.push(() => resolve(ALL_UP[config.name]));
        }),
    );

    const run = runCli(["provider:health"]);
    await new Promise((resolve) => setImmediate(resolve));

    // Every provider has been pinged before any of the pings has settled.
    expect(mockPingProvider).toHaveBeenCalledTimes(mockProviders.length);
    resolvers.forEach((resolve) => resolve());
    await run;
  });

  it("renders a table with Provider, Status, Balance and Latency columns", async () => {
    mockPings(ALL_UP);

    await runCli(["provider:health"]);

    const table = output();
    expect(table).toMatch(
      /Provider\s+\|\s+Status\s+\|\s+Balance\s+\|\s+Latency/,
    );
    expect(table).toMatch(
      /mtn\s+\|\s+UP\s+\|\s+1,500,000\.5 XAF\s+\|\s+120 ms/,
    );
    expect(table).toMatch(/airtel\s+\|\s+UP\s+\|\s+250,000 XAF\s+\|\s+85 ms/);
    // Providers without a balance API are shown as N/A rather than omitted.
    expect(table).toMatch(/orange\s+\|\s+UP\s+\|\s+N\/A\s+\|\s+310 ms/);
    expect(table).toMatch(/wave_senegal\s+\|\s+UP\s+\|\s+N\/A\s+\|\s+45 ms/);
  });

  it("exits with code 0 when every primary provider is UP", async () => {
    mockPings(ALL_UP);

    await runCli(["provider:health"]);

    expect(process.exitCode).toBeUndefined();
    expect(output()).toContain("All primary providers are UP");
  });

  it("exits non-zero when a primary provider is DOWN", async () => {
    mockPings({ ...ALL_UP, mtn: { status: "down", responseTime: null } });

    await runCli(["provider:health"]);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[CLI_PROVIDER_DOWN] Primary provider(s) DOWN: mtn",
      ),
    );
    // A DOWN provider is shown with no latency and its balance is not queried.
    expect(output()).toMatch(/mtn\s+\|\s+DOWN\s+\|\s+N\/A\s+\|\s+-/);
    expect(mockMtnBalance).not.toHaveBeenCalled();
  });

  it("still exits 0 when only a non-primary provider is DOWN", async () => {
    mockPings({ ...ALL_UP, orange: { status: "down", responseTime: null } });

    await runCli(["provider:health"]);

    expect(process.exitCode).toBeUndefined();
    expect(output()).toMatch(/orange\s+\|\s+DOWN/);
  });

  it("honours MOMO_PRIMARY_PROVIDERS when deciding the exit code", async () => {
    process.env.MOMO_PRIMARY_PROVIDERS = "mtn, orange";
    mockPings({ ...ALL_UP, orange: { status: "down", responseTime: null } });

    await runCli(["provider:health"]);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Primary provider(s) DOWN: orange"),
    );
  });

  it("shows N/A for the balance when the balance lookup fails", async () => {
    mockPings(ALL_UP);
    mockMtnBalance.mockRejectedValue(new Error("boom"));
    mockAirtelBalance.mockResolvedValue({ success: false, error: "denied" });

    await runCli(["provider:health"]);

    expect(output()).toMatch(/mtn\s+\|\s+UP\s+\|\s+N\/A/);
    expect(output()).toMatch(/airtel\s+\|\s+UP\s+\|\s+N\/A/);
    // A failed balance lookup does not mark a reachable provider as DOWN.
    expect(process.exitCode).toBeUndefined();
  });

  it("fails with an execution error when the health check itself throws", async () => {
    mockPingProvider.mockRejectedValue(new Error("network unreachable"));

    await runCli(["provider:health"]);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[CLI_EXECUTION_FAILED] Unable to check provider health",
      ),
    );
  });
});

describe("formatTable", () => {
  it("pads each column to its widest cell and separates the header", () => {
    const table = formatTable(
      ["Provider", "Status"],
      [
        ["mtn", "UP"],
        ["wave_senegal", "DOWN"],
      ],
    );

    expect(table.split("\n")).toEqual([
      "Provider     | Status",
      "-------------+-------",
      "mtn          | UP",
      "wave_senegal | DOWN",
    ]);
  });

  it("renders only the header when there are no rows", () => {
    expect(formatTable(["A", "B"], []).split("\n")).toEqual(["A | B", "--+--"]);
  });
});
