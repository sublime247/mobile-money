import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import {
  DEFAULT_FLOAT_PROVIDERS,
  fetchProviderFloat,
  queryAllFloatBalances,
  buildFloatCheckTable,
  executeFloatCheck,
  registerFloatCheckCommand,
  ProviderFloatResult,
  ProviderEndpointConfig,
} from "../src/commands/floatCheck";

test("floatCheck command test suite", async (t) => {
  await t.test("DEFAULT_FLOAT_PROVIDERS includes MTN, Orange, Airtel, M-Pesa, and EcoCash", () => {
    const providerNames = DEFAULT_FLOAT_PROVIDERS.map((p) => p.name);
    assert.deepEqual(providerNames, ["MTN", "Orange", "Airtel", "M-Pesa", "EcoCash"]);

    const currencies = DEFAULT_FLOAT_PROVIDERS.map((p) => p.currency);
    assert.deepEqual(currencies, ["UGX", "XAF", "UGX", "KES", "USD"]);
  });

  await t.test("fetchProviderFloat queries provider and returns balance with status OK", async () => {
    const provider: ProviderEndpointConfig = {
      name: "MTN",
      currency: "UGX",
      endpointUrl: "https://sandbox.test/mtn/balance",
      envUrlKey: "MTN_FLOAT_TEST_URL",
      minThreshold: 10_000,
    };

    const result = await fetchProviderFloat(provider, async () => {
      return { balance: 500000, currency: "UGX" };
    });

    assert.equal(result.provider, "MTN");
    assert.equal(result.currency, "UGX");
    assert.equal(result.currentBalance, 500000);
    assert.equal(result.status, "OK");
    assert.ok(typeof result.latencyMs === "number");
  });

  await t.test("fetchProviderFloat flags LOW_FLOAT when balance is below threshold", async () => {
    const provider: ProviderEndpointConfig = {
      name: "M-Pesa",
      currency: "KES",
      endpointUrl: "https://sandbox.test/mpesa/balance",
      envUrlKey: "MPESA_FLOAT_TEST_URL",
      minThreshold: 20_000,
    };

    const result = await fetchProviderFloat(provider, async () => {
      return { balance: 5000, currency: "KES" };
    });

    assert.equal(result.provider, "M-Pesa");
    assert.equal(result.currentBalance, 5000);
    assert.equal(result.status, "LOW_FLOAT");
  });

  await t.test("fetchProviderFloat handles errors gracefully with status ERROR", async () => {
    const provider: ProviderEndpointConfig = {
      name: "Orange",
      currency: "XAF",
      endpointUrl: "https://sandbox.test/orange/balance",
      envUrlKey: "ORANGE_FLOAT_TEST_URL",
      minThreshold: 50_000,
    };

    const result = await fetchProviderFloat(provider, async () => {
      throw new Error("Connection timeout (ETIMEDOUT)");
    });

    assert.equal(result.provider, "Orange");
    assert.equal(result.currentBalance, 0);
    assert.equal(result.status, "ERROR");
    assert.match(result.error || "", /ETIMEDOUT/);
  });

  await t.test("queryAllFloatBalances queries all 5 providers concurrently", async () => {
    const queryOrder: string[] = [];

    const mockFetchers = {
      MTN: async () => {
        queryOrder.push("MTN");
        return { balance: 1_250_000, currency: "UGX" };
      },
      Orange: async () => {
        queryOrder.push("Orange");
        return { balance: 800_000, currency: "XAF" };
      },
      Airtel: async () => {
        queryOrder.push("Airtel");
        return { balance: 950_000, currency: "UGX" };
      },
      "M-Pesa": async () => {
        queryOrder.push("M-Pesa");
        return { balance: 45_000, currency: "KES" };
      },
      EcoCash: async () => {
        queryOrder.push("EcoCash");
        return { balance: 12_500, currency: "USD" };
      },
    };

    const results = await queryAllFloatBalances(DEFAULT_FLOAT_PROVIDERS, mockFetchers);

    assert.equal(results.length, 5);
    assert.equal(queryOrder.length, 5);

    const mtn = results.find((r) => r.provider === "MTN");
    const orange = results.find((r) => r.provider === "Orange");
    const airtel = results.find((r) => r.provider === "Airtel");
    const mpesa = results.find((r) => r.provider === "M-Pesa");
    const ecocash = results.find((r) => r.provider === "EcoCash");

    assert.ok(mtn && orange && airtel && mpesa && ecocash);
    assert.equal(mtn.currentBalance, 1_250_000);
    assert.equal(orange.currentBalance, 800_000);
    assert.equal(airtel.currentBalance, 950_000);
    assert.equal(mpesa.currentBalance, 45_000);
    assert.equal(ecocash.currentBalance, 12_500);

    assert.equal(mtn.status, "OK");
    assert.equal(orange.status, "OK");
    assert.equal(airtel.status, "OK");
    assert.equal(mpesa.status, "OK");
    assert.equal(ecocash.status, "OK");
  });

  await t.test("queryAllFloatBalances handles partial failure without failing other providers", async () => {
    const mockFetchers = {
      MTN: async () => ({ balance: 1_000_000, currency: "UGX" }),
      Orange: async () => {
        throw new Error("HTTP 503 Service Unavailable");
      },
      Airtel: async () => ({ balance: 500_000, currency: "UGX" }),
      "M-Pesa": async () => ({ balance: 30_000, currency: "KES" }),
      EcoCash: async () => ({ balance: 2_000, currency: "USD" }),
    };

    const results = await queryAllFloatBalances(DEFAULT_FLOAT_PROVIDERS, mockFetchers);

    assert.equal(results.length, 5);
    const orange = results.find((r) => r.provider === "Orange");
    const mtn = results.find((r) => r.provider === "MTN");

    assert.ok(orange && mtn);
    assert.equal(orange.status, "ERROR");
    assert.match(orange.error || "", /503/);
    assert.equal(mtn.status, "OK");
  });

  await t.test("buildFloatCheckTable renders table with correct columns and data", () => {
    const sampleResults: ProviderFloatResult[] = [
      {
        provider: "MTN",
        currency: "UGX",
        currentBalance: 1250000,
        status: "OK",
        latencyMs: 120,
      },
      {
        provider: "Orange",
        currency: "XAF",
        currentBalance: 25000,
        status: "LOW_FLOAT",
        latencyMs: 150,
      },
      {
        provider: "EcoCash",
        currency: "USD",
        currentBalance: 0,
        status: "ERROR",
        latencyMs: 500,
        error: "Gateway timeout",
      },
    ];

    const tableStr = buildFloatCheckTable(sampleResults);

    assert.ok(tableStr.includes("Provider"));
    assert.ok(tableStr.includes("Currency"));
    assert.ok(tableStr.includes("Current Balance"));
    assert.ok(tableStr.includes("Status"));
    assert.ok(tableStr.includes("MTN"));
    assert.ok(tableStr.includes("Orange"));
    assert.ok(tableStr.includes("EcoCash"));
    assert.ok(tableStr.includes("UGX"));
    assert.ok(tableStr.includes("XAF"));
    assert.ok(tableStr.includes("USD"));
  });

  await t.test("executeFloatCheck handles --json flag and outputs JSON payload", async () => {
    const originalLog = console.log;
    let loggedJson = "";
    console.log = (msg: string) => {
      loggedJson = msg;
    };

    try {
      const mockFetchers = {
        MTN: async () => ({ balance: 1000, currency: "UGX" }),
        Orange: async () => ({ balance: 2000, currency: "XAF" }),
        Airtel: async () => ({ balance: 3000, currency: "UGX" }),
        "M-Pesa": async () => ({ balance: 4000, currency: "KES" }),
        EcoCash: async () => ({ balance: 5000, currency: "USD" }),
      };

      const results = await executeFloatCheck({ json: true }, DEFAULT_FLOAT_PROVIDERS, mockFetchers);

      assert.equal(results.length, 5);
      const parsed = JSON.parse(loggedJson);
      assert.equal(Array.isArray(parsed), true);
      assert.equal(parsed.length, 5);
      assert.equal(parsed[0].provider, "MTN");
      assert.equal(parsed[0].currentBalance, 1000);
    } finally {
      console.log = originalLog;
    }
  });

  await t.test("registerFloatCheckCommand adds float:check command to commander", () => {
    const program = new Command();
    registerFloatCheckCommand(program);

    const cmd = program.commands.find((c) => c.name() === "float:check");
    assert.ok(cmd, "float:check command should be registered");
    assert.equal(cmd.name(), "float:check");

    const jsonOption = cmd.options.find((o) => o.long === "--json");
    assert.ok(jsonOption, "--json option should be present");
  });
});

