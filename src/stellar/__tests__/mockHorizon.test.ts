import { MockHorizonServer } from "../mockHorizon";
import http from "http";

describe("Mock Horizon Server Network Outage & Failover Testing (#1835)", () => {
  let mockHorizon: MockHorizonServer;
  let serverUrl: string;

  beforeAll(async () => {
    mockHorizon = new MockHorizonServer();
    serverUrl = await mockHorizon.start();
  });

  afterAll(async () => {
    await mockHorizon.stop();
  });

  afterEach(() => {
    mockHorizon.restore();
  });

  function fetchUrl(url: string, timeoutMs: number = 3000): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode || 200, body: JSON.parse(data), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode || 200, body: data, headers: res.headers });
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
    });
  }

  it("responds with healthy status and account info when operating normally", async () => {
    const health = await fetchUrl(`${serverUrl}/health`);
    expect(health.status).toBe(200);
    expect(health.body.horizon_version).toBeDefined();

    const account = await fetchUrl(`${serverUrl}/accounts/GABCD123456789`);
    expect(account.status).toBe(200);
    expect(account.body.account_id).toBe("GABCD123456789");
    expect(account.body.balances).toHaveLength(2);
  });

  it("simulates network outage (connection drop)", async () => {
    mockHorizon.simulateOutage();
    await expect(fetchUrl(`${serverUrl}/health`)).rejects.toThrow();
  });

  it("simulates 503 Horizon service unavailable error", async () => {
    mockHorizon.simulateError(503, "Horizon Outage");
    const res = await fetchUrl(`${serverUrl}/health`);
    expect(res.status).toBe(503);
    expect(res.body.detail).toBe("Horizon Outage");
  });

  it("simulates 429 rate limit exceeded with Retry-After header", async () => {
    mockHorizon.simulateRateLimit(120);
    const res = await fetchUrl(`${serverUrl}/health`);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("120");
    expect(res.body.title).toBe("Rate Limit Exceeded");
  });

  it("restores to healthy status after outage simulation", async () => {
    mockHorizon.simulateOutage();
    mockHorizon.restore();

    const health = await fetchUrl(`${serverUrl}/health`);
    expect(health.status).toBe(200);
    expect(health.body.horizon_version).toBeDefined();
  });
});
