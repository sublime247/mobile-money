import { Server } from "http";
import * as StellarSdk from "stellar-sdk";
import { HorizonPool } from "../horizonPool";
import {
  startHorizonMockServer,
  stopHorizonMockServer,
  setHorizonChaos,
  resetHorizonChaos,
} from "../../mocks/horizonMockServer";

const TEST_ACCOUNT_1 = StellarSdk.Keypair.random().publicKey();
const TEST_ACCOUNT_2 = StellarSdk.Keypair.random().publicKey();
const TEST_ACCOUNT_FAILOVER = StellarSdk.Keypair.random().publicKey();
const TEST_ACCOUNT_RATELIMIT = StellarSdk.Keypair.random().publicKey();
const TEST_ACCOUNT_RECOVERED = StellarSdk.Keypair.random().publicKey();

describe("Horizon Network Outage & Failover Integration", () => {
  let serverA: Server;
  let urlA: string;
  let serverB: Server;
  let urlB: string;

  beforeAll(async () => {
    const resA = await startHorizonMockServer(0);
    serverA = resA.server;
    urlA = resA.url;

    const resB = await startHorizonMockServer(0);
    serverB = resB.server;
    urlB = resB.url;
  });

  afterAll(async () => {
    if (serverA) await stopHorizonMockServer(serverA);
    if (serverB) await stopHorizonMockServer(serverB);
  });

  beforeEach(() => {
    resetHorizonChaos();
  });

  it("rotates requests between live Horizon mock nodes under normal operation", async () => {
    const pool = new HorizonPool([urlA, urlB]);
    const proxied = pool.getProxiedServer();

    const acct1 = await proxied.loadAccount(TEST_ACCOUNT_1);
    expect(acct1.id).toBe(TEST_ACCOUNT_1);

    const acct2 = await proxied.loadAccount(TEST_ACCOUNT_2);
    expect(acct2.id).toBe(TEST_ACCOUNT_2);
  });

  it("fails over to secondary node when primary node encounters 503 outage", async () => {
    const pool = new HorizonPool([urlA, urlB], {
      maxConsecutiveFailures: 1,
      cooldownMs: 5000,
    });

    // The execute call should fail on urlA and automatically failover to urlB
    const acct = await pool.execute(async (server) => {
      if (server.serverURL.toString().includes(urlA)) {
        throw Object.assign(new Error("503 Outage"), { response: { status: 503 } });
      }
      return server.loadAccount(TEST_ACCOUNT_FAILOVER);
    }, "loadAccount");

    expect(acct.id).toBe(TEST_ACCOUNT_FAILOVER);
  });

  it("handles total network outage when all Horizon nodes are down", async () => {
    const pool = new HorizonPool([urlA, urlB]);

    await expect(
      pool.execute(async () => {
        throw Object.assign(new Error("Network Outage - 503"), {
          response: { status: 503 },
        });
      }, "loadAccount"),
    ).rejects.toThrow("Network Outage - 503");
  });

  it("handles rate limiting (429) as failover-eligible and switches nodes", async () => {
    const pool = new HorizonPool([urlA, urlB], {
      maxConsecutiveFailures: 1,
      cooldownMs: 5000,
    });

    let attemptedA = false;
    let attemptedB = false;

    const result = await pool.execute(async (server) => {
      if (server.serverURL.toString().includes(urlA)) {
        attemptedA = true;
        throw Object.assign(new Error("Rate limited"), {
          response: { status: 429, headers: { "retry-after": "5" } },
        });
      }
      attemptedB = true;
      return server.loadAccount(TEST_ACCOUNT_RATELIMIT);
    }, "loadAccount");

    expect(attemptedA).toBe(true);
    expect(attemptedB).toBe(true);
    expect(result.id).toBe(TEST_ACCOUNT_RATELIMIT);
  });

  it("recovers node rotation when outage is resolved", async () => {
    const pool = new HorizonPool([urlA, urlB], {
      maxConsecutiveFailures: 1,
      cooldownMs: 100, // Short cooldown for testing recovery
    });

    // Simulate temporary outage on urlA
    try {
      await pool.execute(async (server) => {
        if (server.serverURL.toString().includes(urlA)) {
          throw Object.assign(new Error("Transient Outage"), { response: { status: 503 } });
        }
        return server.loadAccount(TEST_ACCOUNT_1);
      }, "loadAccount");
    } catch {
      // ignore
    }

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 150));

    // Next request can hit recovered nodes normally
    const result = await pool.getProxiedServer().loadAccount(TEST_ACCOUNT_RECOVERED);
    expect(result.id).toBe(TEST_ACCOUNT_RECOVERED);
  });
});

