jest.mock("../../services/mobilemoney/providers/healthCheck", () => ({
  checkMobileMoneyHealth: jest.fn(),
}));
jest.mock("../../services/providerSettingsService", () => ({
  providerSettingsService: { getProviderSettings: jest.fn() },
}));

import axios, { AxiosError, type AxiosAdapter } from "axios";
import {
  CircuitOpenError,
  CircuitState,
  RollingCircuitBreaker,
  getProviderCircuitBreaker,
  resetProviderCircuitBreakers,
} from "../circuitBreaker";
import {
  BaseProvider,
  attachCircuitBreakerInterceptor,
  isProviderFailure,
} from "../../providers/baseProvider";

function clock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function breaker(c = clock(), overrides = {}) {
  return new RollingCircuitBreaker("mtn", {
    now: c.now,
    minimumRequests: 4,
    ...overrides,
  });
}

const ok = () => Promise.resolve("ok");
const boom = () => Promise.reject(new Error("telco down"));

describe("RollingCircuitBreaker – trip threshold", () => {
  it("starts CLOSED with defaults of 50% / 30s window / 60s cooldown", () => {
    const b = new RollingCircuitBreaker("wave");
    expect(b.getState()).toBe(CircuitState.CLOSED);
    expect((b as any).errorThreshold).toBe(0.5);
    expect((b as any).windowMs).toBe(30_000);
    expect((b as any).cooldownMs).toBe(60_000);
  });

  it("stays CLOSED at exactly 50% errors", async () => {
    const b = breaker();
    for (const fn of [ok, boom, ok, boom]) await fn().then(() => b.recordSuccess(), () => b.recordFailure());
    expect(b.getErrorRate()).toBe(0.5);
    expect(b.getState()).toBe(CircuitState.CLOSED);
  });

  it("trips OPEN once the error rate exceeds 50%", async () => {
    const b = breaker();
    await b.execute(ok);
    for (let i = 0; i < 3; i++) await expect(b.execute(boom)).rejects.toThrow("telco down");
    expect(b.getState()).toBe(CircuitState.OPEN);
  });

  it("does not trip below the minimum request volume", async () => {
    const b = breaker();
    for (let i = 0; i < 3; i++) await expect(b.execute(boom)).rejects.toThrow();
    expect(b.getState()).toBe(CircuitState.CLOSED);
  });

  it("only counts outcomes inside the 30s rolling window", async () => {
    const c = clock();
    const b = breaker(c);
    for (let i = 0; i < 3; i++) await expect(b.execute(boom)).rejects.toThrow();
    c.advance(30_001); // old failures fall out of the window
    await b.execute(ok);
    await b.execute(ok);
    await b.execute(ok);
    await expect(b.execute(boom)).rejects.toThrow();
    expect(b.getErrorRate()).toBe(0.25);
    expect(b.getState()).toBe(CircuitState.CLOSED);
  });
});

describe("RollingCircuitBreaker – OPEN fast-fail", () => {
  async function tripped(c = clock()) {
    const b = breaker(c);
    for (let i = 0; i < 4; i++) await expect(b.execute(boom)).rejects.toThrow();
    expect(b.getState()).toBe(CircuitState.OPEN);
    return b;
  }

  it("rejects with a descriptive 503 without invoking the provider", async () => {
    const b = await tripped();
    const call = jest.fn(ok);
    const err = await b.execute(call).catch((e) => e);

    expect(call).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("SERVICE_UNAVAILABLE");
    expect(err.message).toMatch(/mtn is temporarily unavailable.*OPEN.*Retry in ~60s/);
  });

  it("stays OPEN until the 60s cooldown elapses", async () => {
    const c = clock();
    const b = await tripped(c);
    c.advance(59_999);
    expect(b.getState()).toBe(CircuitState.OPEN);
    c.advance(1);
    expect(b.getState()).toBe(CircuitState.HALF_OPEN);
  });
});

describe("RollingCircuitBreaker – HALF_OPEN recovery trial", () => {
  async function halfOpen(c = clock()) {
    const b = breaker(c);
    for (let i = 0; i < 4; i++) await expect(b.execute(boom)).rejects.toThrow();
    c.advance(60_000);
    expect(b.getState()).toBe(CircuitState.HALF_OPEN);
    return b;
  }

  it("routes exactly one trial request; concurrent callers fast-fail", async () => {
    const b = await halfOpen();
    let release!: (v: string) => void;
    const trial = jest.fn(() => new Promise<string>((r) => (release = r)));
    const other = jest.fn(ok);

    const trialPromise = b.execute(trial);
    await expect(b.execute(other)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(trial).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();

    release("ok");
    await expect(trialPromise).resolves.toBe("ok");
    expect(b.getState()).toBe(CircuitState.CLOSED);
  });

  it("closes and clears history when the trial succeeds", async () => {
    const b = await halfOpen();
    await b.execute(ok);
    expect(b.getState()).toBe(CircuitState.CLOSED);
    expect(b.getErrorRate()).toBe(0);
    await expect(b.execute(ok)).resolves.toBe("ok");
  });

  it("re-opens and restarts the cooldown when the trial fails", async () => {
    const c = clock();
    const b = await halfOpen(c);
    await expect(b.execute(boom)).rejects.toThrow("telco down");
    expect(b.getState()).toBe(CircuitState.OPEN);
    c.advance(30_000);
    expect(b.getState()).toBe(CircuitState.OPEN);
    c.advance(30_000);
    expect(b.getState()).toBe(CircuitState.HALF_OPEN);
  });

  it("reports every transition", async () => {
    const c = clock();
    const transitions: string[] = [];
    const b = breaker(c, { onStateChange: (f: string, t: string) => transitions.push(`${f}->${t}`) });
    for (let i = 0; i < 4; i++) await expect(b.execute(boom)).rejects.toThrow();
    c.advance(60_000);
    await b.execute(ok);
    expect(transitions).toEqual([
      "CLOSED->OPEN",
      "OPEN->HALF_OPEN",
      "HALF_OPEN->CLOSED",
    ]);
  });
});

describe("provider failure classification", () => {
  const axiosErr = (status?: number) =>
    new AxiosError("x", "ERR", undefined, undefined, status ? ({ status } as any) : undefined);

  it("counts transport errors, 5xx and 429 but not 4xx", () => {
    expect(isProviderFailure(axiosErr())).toBe(true);
    expect(isProviderFailure(axiosErr(502))).toBe(true);
    expect(isProviderFailure(axiosErr(429))).toBe(true);
    expect(isProviderFailure(axiosErr(400))).toBe(false);
    expect(isProviderFailure(axiosErr(404))).toBe(false);
    expect(isProviderFailure(new CircuitOpenError("mtn", 1))).toBe(false);
  });
});

describe("telco HTTP adapter integration", () => {
  beforeEach(() => resetProviderCircuitBreakers());

  function stubAdapter(statuses: number[]): { adapter: AxiosAdapter; calls: () => number } {
    let n = 0;
    const adapter: AxiosAdapter = async (config) => {
      const status = statuses[Math.min(n, statuses.length - 1)];
      n++;
      const response = { data: {}, status, statusText: "", headers: {}, config };
      if (status >= 400) {
        throw new AxiosError("fail", "ERR_BAD_RESPONSE", config, undefined, response as any);
      }
      return response;
    };
    return { adapter, calls: () => n };
  }

  it("axios interceptor trips, fast-fails without network, then recovers", async () => {
    const c = clock();
    const b = new RollingCircuitBreaker("orange", { now: c.now, minimumRequests: 3 });
    const stub = stubAdapter([503, 503, 503, 200]);
    const client = attachCircuitBreakerInterceptor(axios.create({ adapter: stub.adapter }), "orange", b);

    for (let i = 0; i < 3; i++) await expect(client.get("/pay")).rejects.toThrow("fail");
    expect(b.getState()).toBe(CircuitState.OPEN);

    await expect(client.get("/pay")).rejects.toBeInstanceOf(CircuitOpenError);
    expect(stub.calls()).toBe(3); // dead endpoint not hit

    c.advance(60_000);
    await expect(client.get("/pay")).resolves.toMatchObject({ status: 200 });
    expect(b.getState()).toBe(CircuitState.CLOSED);
  });

  it("4xx responses do not trip the circuit", async () => {
    const b = new RollingCircuitBreaker("wave", { minimumRequests: 2 });
    const client = attachCircuitBreakerInterceptor(
      axios.create({ adapter: stubAdapter([400]).adapter }),
      "wave",
      b,
    );
    for (let i = 0; i < 5; i++) await expect(client.get("/x")).rejects.toThrow();
    expect(b.getState()).toBe(CircuitState.CLOSED);
  });

  it("BaseProvider subclasses inherit protection", async () => {
    const c = clock();
    const b = new RollingCircuitBreaker("mpesa", { now: c.now, minimumRequests: 2 });
    const stub = stubAdapter([500]);
    class MpesaAdapter extends BaseProvider {
      constructor() {
        super("mpesa", axios.create({ adapter: stub.adapter }), b);
      }
      stkPush() {
        return this.request({ method: "POST", url: "/stkpush" });
      }
    }
    const mpesa = new MpesaAdapter();
    await expect(mpesa.stkPush()).rejects.toThrow();
    await expect(mpesa.stkPush()).rejects.toThrow();
    expect(mpesa.circuitState).toBe(CircuitState.OPEN);
    await expect(mpesa.stkPush()).rejects.toMatchObject({ statusCode: 503 });
    expect(stub.calls()).toBe(2);
  });

  it("shares one breaker per provider", () => {
    expect(getProviderCircuitBreaker("MTN")).toBe(getProviderCircuitBreaker("mtn"));
    expect(getProviderCircuitBreaker("mtn")).not.toBe(getProviderCircuitBreaker("wave"));
  });
});
