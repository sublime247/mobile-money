/**
 * Oracle-backed local fiat rates (#1622).
 *
 * The Soroban oracle contract is never contacted: `IOracleClient` is replaced
 * by an in-memory fake, and the RPC server used by `SorobanOracleClient` is a
 * stub that returns canned simulation responses.
 */

// The real SDK pulls in ESM-only dependencies that Jest cannot load here (the
// same reason other suites mock it), so a minimal stand-in is used. It records
// what the client asks of it instead of building real XDR.
jest.mock("@stellar/stellar-sdk", () => {
  const isAddress = (value: string) => /^[CG][A-Z2-7]{55}$/.test(value);
  return {
    Networks: {
      TESTNET: "Test SDF Network ; September 2015",
      PUBLIC: "Public Global Stellar Network ; September 2015",
    },
    BASE_FEE: "100",
    StrKey: {
      isValidContract: (value: string) => /^C[A-Z2-7]{55}$/.test(value),
    },
    Address: class {
      constructor(readonly value: string) {
        if (!isAddress(value)) throw new Error("Unsupported address type");
      }
      toScVal() {
        return { type: "address", value: this.value };
      }
    },
    Account: class {
      constructor(
        readonly id: string,
        readonly sequence: string,
      ) {}
    },
    Contract: class {
      constructor(readonly id: string) {}
      call(method: string, ...args: unknown[]) {
        return { contract: this.id, method, args };
      }
    },
    TransactionBuilder: class {
      private operation: unknown;
      addOperation(operation: unknown) {
        this.operation = operation;
        return this;
      }
      setTimeout() {
        return this;
      }
      build() {
        return { operation: this.operation };
      }
    },
    nativeToScVal: (value: unknown, options: { type: string }) => ({
      type: options.type,
      value,
    }),
    scValToNative: (scVal: { value: unknown }) => scVal.value,
    rpc: {
      Server: class {},
      Api: { isSimulationError: (sim: object) => "error" in sim },
    },
  };
});

import logger from "../../utils/logger";
import { CurrencyService } from "../currency";
import {
  IOracleClient,
  OracleError,
  OracleQuoteRequest,
  SorobanOracleClient,
} from "../oracle/oracleClient";
import {
  OracleRateProvider,
  loadOracleRateConfig,
} from "../oracle/oracleRateProvider";

// Valid contract ids (StrKey-encoded 32-byte fills).
const ORACLE_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const ASSETS: Record<string, string> = {
  USD: "CAFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUTSM",
  NGN: "CAFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQX4KO",
  KES: "CAGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAZTCD",
};
const CURRENCY_BY_ASSET = Object.fromEntries(
  Object.entries(ASSETS).map(([currency, asset]) => [asset, currency]),
);

const CONFIG = {
  assetMap: ASSETS,
  quoteAmount: 10_000_000n,
  maxSpreadBps: 100,
  cacheTtlMs: 60_000,
};

/** Units of each currency per USD as the fake oracle prices them. */
const ORACLE_TABLE: Record<string, number> = { USD: 1, NGN: 1500, KES: 129 };

/** Fake oracle: converts through USD and takes `feeBps` off every quote. */
function fakeOracle(feeBps = 20) {
  const getRateWithSpread = jest.fn(
    async ({ assetIn, assetOut, amountIn }: OracleQuoteRequest) => {
      const ratio =
        (ORACLE_TABLE[CURRENCY_BY_ASSET[assetOut]] /
          ORACLE_TABLE[CURRENCY_BY_ASSET[assetIn]]) *
        (1 - feeBps / 10_000);
      return BigInt(Math.floor(Number(amountIn) * ratio));
    },
  );
  return { getRateWithSpread } as IOracleClient & {
    getRateWithSpread: jest.Mock;
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("loadOracleRateConfig", () => {
  const enabledEnv = {
    ORACLE_RATES_ENABLED: "true",
    ORACLE_CONTRACT_ID: ORACLE_ID,
    ORACLE_ASSET_MAP: JSON.stringify(ASSETS),
    STELLAR_NETWORK: "testnet",
  } as unknown as NodeJS.ProcessEnv;

  beforeEach(() => {
    jest.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  it("is off unless ORACLE_RATES_ENABLED is true", () => {
    expect(loadOracleRateConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      loadOracleRateConfig({
        ...enabledEnv,
        ORACLE_RATES_ENABLED: "false",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("applies defaults, including the public testnet RPC", () => {
    const config = loadOracleRateConfig(enabledEnv);

    expect(config).toMatchObject({
      contractId: ORACLE_ID,
      rpcUrl: "https://soroban-testnet.stellar.org",
      assetMap: ASSETS,
      quoteAmount: 10_000_000n,
      maxSpreadBps: 100,
      cacheTtlMs: 60_000,
      timeoutMs: 5_000,
    });
  });

  it("reads overrides from the environment", () => {
    const config = loadOracleRateConfig({
      ...enabledEnv,
      ORACLE_RPC_URL: "https://rpc.example.org",
      ORACLE_QUOTE_AMOUNT: "500000000",
      ORACLE_MAX_SPREAD_BPS: "50",
      ORACLE_CACHE_TTL_MS: "1000",
    } as NodeJS.ProcessEnv);

    expect(config).toMatchObject({
      rpcUrl: "https://rpc.example.org",
      quoteAmount: 500_000_000n,
      maxSpreadBps: 50,
      cacheTtlMs: 1000,
    });
  });

  it.each([
    ["an invalid contract id", { ORACLE_CONTRACT_ID: "not-a-contract" }],
    ["a missing asset map", { ORACLE_ASSET_MAP: "" }],
    ["a malformed asset map", { ORACLE_ASSET_MAP: '{"USD":"nope"}' }],
    [
      "an asset map without USD",
      { ORACLE_ASSET_MAP: JSON.stringify({ NGN: ASSETS.NGN }) },
    ],
    ["a zero spread limit", { ORACLE_MAX_SPREAD_BPS: "0" }],
    ["mainnet without an RPC url", { STELLAR_NETWORK: "mainnet" }],
  ])("stays disabled (and warns) with %s", (_label, override) => {
    const config = loadOracleRateConfig({
      ...enabledEnv,
      ...override,
    } as NodeJS.ProcessEnv);

    expect(config).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[OracleRates] Disabled"),
    );
  });
});

describe("OracleRateProvider", () => {
  it("returns units of `to` per unit of `from` from the oracle quote", async () => {
    const client = fakeOracle(20);
    const provider = new OracleRateProvider(client, CONFIG);

    const rate = await provider.getRate("USD", "NGN");

    // 1500 NGN per USD less the oracle's 20 bps fee
    expect(rate).toBeCloseTo(1500 * 0.998, 3);
    expect(client.getRateWithSpread).toHaveBeenNthCalledWith(1, {
      assetIn: ASSETS.USD,
      assetOut: ASSETS.NGN,
      amountIn: 10_000_000n,
      maxSpreadBps: 100,
    });
  });

  it("does not query the oracle for a currency against itself", async () => {
    const client = fakeOracle();
    const provider = new OracleRateProvider(client, CONFIG);

    expect(await provider.getRate("NGN", "NGN")).toBe(1);
    expect(client.getRateWithSpread).not.toHaveBeenCalled();
  });

  it("caches a rate until the TTL expires", async () => {
    const client = fakeOracle();
    let now = 1_000_000;
    const provider = new OracleRateProvider(client, CONFIG, () => now);

    const first = await provider.getRate("USD", "KES");
    const calls = client.getRateWithSpread.mock.calls.length;

    now += 59_000;
    expect(await provider.getRate("USD", "KES")).toBe(first);
    expect(client.getRateWithSpread).toHaveBeenCalledTimes(calls);

    now += 2_000;
    await provider.getRate("USD", "KES");
    expect(client.getRateWithSpread.mock.calls.length).toBeGreaterThan(calls);
  });

  it("rejects a quote whose round trip would make a profit (arbitrage)", async () => {
    const client: IOracleClient = {
      getRateWithSpread: jest
        .fn<Promise<bigint>, [OracleQuoteRequest]>()
        .mockResolvedValueOnce(15_000_000_000n) // 1500 NGN for 1 USD
        .mockResolvedValueOnce(10_500_000n), // ...and 1.05 USD back
    };
    const provider = new OracleRateProvider(client, CONFIG);

    await expect(provider.getRate("USD", "NGN")).rejects.toMatchObject({
      code: "SPREAD_TOO_HIGH",
      message: expect.stringContaining("arbitrage"),
    });
  });

  it("rejects a quote whose round trip loses more than the allowed spread", async () => {
    const client: IOracleClient = {
      getRateWithSpread: jest
        .fn<Promise<bigint>, [OracleQuoteRequest]>()
        .mockResolvedValueOnce(15_000_000_000n)
        .mockResolvedValueOnce(9_700_000n), // 300 bps lost, limit is 100
    };
    const provider = new OracleRateProvider(client, CONFIG);

    await expect(provider.getRate("USD", "NGN")).rejects.toMatchObject({
      code: "SPREAD_TOO_HIGH",
    });
  });

  it("surfaces the contract's own spread rejection and caches nothing", async () => {
    const client: IOracleClient = {
      getRateWithSpread: jest
        .fn<Promise<bigint>, [OracleQuoteRequest]>()
        .mockRejectedValue(
          new OracleError("pools disagree", "SPREAD_TOO_HIGH"),
        ),
    };
    const provider = new OracleRateProvider(client, CONFIG);

    await expect(provider.getRate("USD", "NGN")).rejects.toMatchObject({
      code: "SPREAD_TOO_HIGH",
    });
    await expect(provider.getRate("USD", "NGN")).rejects.toBeInstanceOf(
      OracleError,
    );
    expect(client.getRateWithSpread).toHaveBeenCalledTimes(2);
  });

  it("refuses currencies that have no oracle asset", async () => {
    const provider = new OracleRateProvider(fakeOracle(), CONFIG);

    await expect(provider.getRate("USD", "GHS")).rejects.toThrow(/GHS/);
  });

  describe("getUsdRates", () => {
    it("returns rates for mapped currencies and skips the rest", async () => {
      const provider = new OracleRateProvider(fakeOracle(0), CONFIG);

      const rates = await provider.getUsdRates(["USD", "NGN", "KES", "GHS"]);

      expect(Object.keys(rates).sort()).toEqual(["KES", "NGN"]);
      expect(rates.NGN).toBeCloseTo(1500, 3);
      expect(rates.KES).toBeCloseTo(129, 3);
    });

    it("leaves out a currency whose quote fails validation", async () => {
      jest.spyOn(logger, "warn").mockImplementation(() => logger);
      const healthy = fakeOracle(0);
      const client: IOracleClient = {
        getRateWithSpread: jest.fn(async (request: OracleQuoteRequest) => {
          if (
            request.assetIn === ASSETS.KES ||
            request.assetOut === ASSETS.KES
          ) {
            throw new OracleError("pools disagree", "SPREAD_TOO_HIGH");
          }
          return healthy.getRateWithSpread(request);
        }),
      };
      const provider = new OracleRateProvider(client, CONFIG);

      const rates = await provider.getUsdRates(["NGN", "KES"]);

      expect(Object.keys(rates)).toEqual(["NGN"]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("USD/KES"),
      );
    });

    it("returns nothing when USD itself is not mapped", async () => {
      const withoutUsd = Object.fromEntries(
        Object.entries(ASSETS).filter(([currency]) => currency !== "USD"),
      );
      const client = fakeOracle();
      const provider = new OracleRateProvider(client, {
        ...CONFIG,
        assetMap: withoutUsd,
      });

      expect(await provider.getUsdRates(["NGN"])).toEqual({});
      expect(client.getRateWithSpread).not.toHaveBeenCalled();
    });
  });
});

describe("SorobanOracleClient", () => {
  const request: OracleQuoteRequest = {
    assetIn: ASSETS.USD,
    assetOut: ASSETS.NGN,
    amountIn: 10_000_000n,
    maxSpreadBps: 100,
  };

  function clientWith(simulateTransaction: jest.Mock) {
    return new SorobanOracleClient({
      rpcUrl: "https://rpc.example.org",
      contractId: ORACLE_ID,
      networkPassphrase: "Test SDF Network ; September 2015",
      server: { simulateTransaction } as never,
    });
  }

  it("simulates get_rate_with_spread with the quote arguments and reads the i128", async () => {
    const simulate = jest.fn().mockResolvedValue({
      result: { auth: [], retval: { type: "i128", value: 14_970_000_000n } },
    });

    const amountOut = await clientWith(simulate).getRateWithSpread(request);

    expect(amountOut).toBe(14_970_000_000n);
    const { operation } = simulate.mock.calls[0][0];
    expect(operation).toEqual({
      contract: ORACLE_ID,
      method: "get_rate_with_spread",
      args: [
        { type: "address", value: ASSETS.USD },
        { type: "address", value: ASSETS.NGN },
        { type: "i128", value: 10_000_000n },
        { type: "u32", value: 100 },
      ],
    });
  });

  it("maps a contract SpreadTooHigh error to SPREAD_TOO_HIGH", async () => {
    const simulate = jest.fn().mockResolvedValue({
      error: "HostError: Error(Contract, #5)",
    });

    await expect(
      clientWith(simulate).getRateWithSpread(request),
    ).rejects.toMatchObject({ code: "SPREAD_TOO_HIGH" });
  });

  it("reports other simulation errors and RPC failures as UNAVAILABLE", async () => {
    const trapped = jest.fn().mockResolvedValue({
      error: "HostError: Error(WasmVm, InvalidAction)",
    });
    await expect(
      clientWith(trapped).getRateWithSpread(request),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const down = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      clientWith(down).getRateWithSpread(request),
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("rejects a response without a positive quote", async () => {
    const empty = jest.fn().mockResolvedValue({ result: undefined });
    await expect(
      clientWith(empty).getRateWithSpread(request),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const zero = jest.fn().mockResolvedValue({
      result: { auth: [], retval: { type: "i128", value: 0n } },
    });
    await expect(
      clientWith(zero).getRateWithSpread(request),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("CurrencyService with the oracle as its rate source", () => {
  let service: CurrencyService;

  beforeEach(() => {
    service = new CurrencyService();
    jest.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  afterEach(() => {
    service.shutdown();
  });

  it("uses oracle rates where available and static rates for the rest", async () => {
    service.setRateSource(new OracleRateProvider(fakeOracle(0), CONFIG));

    await service.initialize();

    const rates = service.getRates();
    expect(rates.NGN).toBeCloseTo(1500, 3); // oracle (static table says 1550)
    expect(rates.KES).toBeCloseTo(129, 3); // oracle (static table says 130)
    expect(rates.GHS).toBe(15); // not mapped in the oracle: static fallback
    expect(service.convert(1, "USD", "NGN").rate).toBeCloseTo(1500, 3);
  });

  it("falls back to the static rates when the oracle is unavailable", async () => {
    const client: IOracleClient = {
      getRateWithSpread: jest
        .fn<Promise<bigint>, [OracleQuoteRequest]>()
        .mockRejectedValue(new OracleError("rpc down", "UNAVAILABLE")),
    };
    service.setRateSource(new OracleRateProvider(client, CONFIG));

    await service.initialize();

    expect(service.getRates().NGN).toBe(1550);
    expect(service.convert(1, "USD", "KES").rate).toBe(130);
  });

  it("keeps using the static rates when no rate source is set", async () => {
    await service.initialize();

    expect(service.getRates().NGN).toBe(1550);
  });
});
