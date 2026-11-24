import assert from "node:assert/strict";
import test from "node:test";
import {
  pingProvider,
  executeTestConnectivity,
  buildConnectivityTable,
  getDefaultProviderConfigs,
  type ProviderPingConfig,
} from "../src/commands/testConnectivity";

test("providerConnectivity test suite (#2507)", async (t) => {
  await t.test(
    "getDefaultProviderConfigs includes MTN, Orange, Airtel, M-Pesa, and Moov",
    () => {
      const configs = getDefaultProviderConfigs();
      const names = configs.map((c) => c.name);

      assert.ok(names.includes("MTN"), "Should include MTN");
      assert.ok(names.includes("Orange"), "Should include Orange");
      assert.ok(names.includes("Airtel"), "Should include Airtel");
      assert.ok(names.includes("M-Pesa"), "Should include M-Pesa");
      assert.ok(names.includes("Moov"), "Should include Moov");
    },
  );

  await t.test(
    "pingProvider reports OK when provider endpoint responds successfully",
    async () => {
      const config: ProviderPingConfig = {
        name: "MTN",
        url: "https://sandbox.momodeveloper.mtn.com/v1_0/apiuser",
        isCritical: true,
      };

      const mockFetch = async () => ({
        status: 200,
        ok: true,
      });

      const result = await pingProvider(config, 5000, mockFetch);
      assert.equal(result.provider, "MTN");
      assert.equal(result.status, "OK");
      assert.equal(result.authenticated, true);
      assert.ok(result.latencyMs >= 1);
    },
  );

  await t.test(
    "pingProvider detects authentication failure (401 / 403)",
    async () => {
      const config: ProviderPingConfig = {
        name: "M-Pesa",
        url: "https://sandbox.safaricom.co.ke/oauth/v1/generate",
        isCritical: true,
      };

      const mockFetch = async () => ({
        status: 401,
        ok: false,
      });

      const result = await pingProvider(config, 5000, mockFetch);
      assert.equal(result.provider, "M-Pesa");
      assert.equal(result.status, "AUTH_FAILED");
      assert.equal(result.authenticated, false);
      assert.equal(result.httpStatus, 401);
    },
  );

  await t.test("pingProvider handles SSL certificate errors", async () => {
    const config: ProviderPingConfig = {
      name: "Orange",
      url: "https://api.orange.com/orange-money",
      isCritical: true,
    };

    const mockFetch = async () => {
      const err = new Error("certificate has expired");
      (err as any).code = "CERT_HAS_EXPIRED";
      throw err;
    };

    const result = await pingProvider(config, 5000, mockFetch);
    assert.equal(result.status, "SSL_ERROR");
    assert.equal(result.authenticated, false);
  });

  await t.test("pingProvider handles network timeouts", async () => {
    const config: ProviderPingConfig = {
      name: "Moov",
      url: "https://api.moov-africa.com/oauth/token",
      isCritical: true,
    };

    const mockFetch = async () => {
      const err = new Error("request timed out");
      err.name = "AbortError";
      throw err;
    };

    const result = await pingProvider(config, 5000, mockFetch);
    assert.equal(result.status, "TIMEOUT");
    assert.equal(result.authenticated, false);
  });

  await t.test(
    "buildConnectivityTable formats terminal table with required columns",
    () => {
      const results = [
        {
          provider: "MTN",
          endpointUrl: "https://sandbox.momodeveloper.mtn.com",
          latencyMs: 120,
          status: "OK" as const,
          authenticated: true,
        },
        {
          provider: "Orange",
          endpointUrl: "https://api.orange.com",
          latencyMs: 250,
          status: "AUTH_FAILED" as const,
          authenticated: false,
        },
      ];

      const tableStr = buildConnectivityTable(results);
      assert.ok(tableStr.includes("Provider"));
      assert.ok(tableStr.includes("Endpoint URL"));
      assert.ok(tableStr.includes("Latency"));
      assert.ok(tableStr.includes("Status"));
      assert.ok(tableStr.includes("MTN"));
      assert.ok(tableStr.includes("Orange"));
      assert.ok(tableStr.includes("120 ms"));
      assert.ok(tableStr.includes("AUTH_FAILED"));
    },
  );

  await t.test(
    "executeTestConnectivity returns exitCode 1 when any critical provider fails auth",
    async () => {
      const mockFetch = async (url: string) => {
        if (url.includes("moov")) {
          return { status: 401, ok: false };
        }
        return { status: 200, ok: true };
      };

      const output = await executeTestConnectivity({
        fetchImpl: mockFetch,
      });

      assert.equal(output.hasAuthFailure, true);
      assert.equal(output.exitCode, 1);
      assert.equal(output.results.length, 5);

      const moovResult = output.results.find((r) => r.provider === "Moov");
      assert.ok(moovResult);
      assert.equal(moovResult.status, "AUTH_FAILED");
    },
  );

  await t.test(
    "executeTestConnectivity returns exitCode 0 when all providers pass",
    async () => {
      const mockFetch = async () => ({ status: 200, ok: true });

      const output = await executeTestConnectivity({
        fetchImpl: mockFetch,
      });

      assert.equal(output.hasAuthFailure, false);
      assert.equal(output.exitCode, 0);
      assert.equal(output.results.length, 5);
      assert.ok(
        output.results.every((r) => r.status === "OK" && r.authenticated),
      );
    },
  );
});
