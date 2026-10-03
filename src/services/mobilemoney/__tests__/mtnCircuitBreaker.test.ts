import { MtnCircuitBreaker } from "../mtnCircuitBreaker";
import { MtnService } from "../mtnService";
import { MTNProvider } from "../providers/mtn";
import { register } from "../../../utils/metrics";

describe("MTN MoMo Collection Circuit Breaker (#2131)", () => {
  describe("State Transitions and Failure Thresholds", () => {
    it("starts in CLOSED state with 0 consecutive failures", () => {
      const breaker = new MtnCircuitBreaker({
        failureThreshold: 5,
        rollingWindowMs: 60_000,
        cooldownPeriodMs: 30_000,
      });

      expect(breaker.getState()).toBe("CLOSED");
      expect(breaker.isClosed()).toBe(true);
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.isHalfOpen()).toBe(false);
      expect(breaker.getConsecutiveFailures()).toBe(0);
    });

    it("resets consecutive failure counter on successful execution", async () => {
      const breaker = new MtnCircuitBreaker({ failureThreshold: 5 });

      breaker.recordFailure(new Error("failure 1"));
      breaker.recordFailure(new Error("failure 2"));
      expect(breaker.getConsecutiveFailures()).toBe(2);

      breaker.recordSuccess();
      expect(breaker.getConsecutiveFailures()).toBe(0);
      expect(breaker.getState()).toBe("CLOSED");
    });

    it("trips to OPEN when 5 consecutive requests fail within the rolling window", () => {
      const stateTransitions: string[] = [];
      const breaker = new MtnCircuitBreaker({
        failureThreshold: 5,
        rollingWindowMs: 60_000,
        cooldownPeriodMs: 30_000,
        onStateChange: (from, to) => stateTransitions.push(`${from}->${to}`),
      });

      for (let i = 1; i <= 4; i++) {
        breaker.recordFailure(new Error(`Failure ${i}`));
        expect(breaker.getState()).toBe("CLOSED");
        expect(breaker.getConsecutiveFailures()).toBe(i);
      }

      breaker.recordFailure(new Error("Failure 5"));
      expect(breaker.getState()).toBe("OPEN");
      expect(breaker.isOpen()).toBe(true);
      expect(stateTransitions).toEqual(["CLOSED->OPEN"]);
    });

    it("trips to OPEN on timeout failures", async () => {
      const breaker = new MtnCircuitBreaker({
        failureThreshold: 5,
        rollingWindowMs: 60_000,
        cooldownPeriodMs: 30_000,
        requestTimeoutMs: 50,
      });

      const hangingAction = () =>
        new Promise((resolve) => setTimeout(resolve, 150));

      for (let i = 1; i <= 5; i++) {
        try {
          await breaker.execute(hangingAction);
        } catch (err: any) {
          expect(err.code).toBe("ETIMEDOUT");
        }
      }

      expect(breaker.getState()).toBe("OPEN");
      expect(breaker.isOpen()).toBe(true);
    });

    it("does not trip if failures are interleaved with a success", () => {
      const breaker = new MtnCircuitBreaker({ failureThreshold: 5 });

      for (let i = 0; i < 4; i++) {
        breaker.recordFailure(new Error("fail"));
      }
      expect(breaker.getConsecutiveFailures()).toBe(4);

      breaker.recordSuccess();
      expect(breaker.getConsecutiveFailures()).toBe(0);

      for (let i = 0; i < 4; i++) {
        breaker.recordFailure(new Error("fail"));
      }
      expect(breaker.getState()).toBe("CLOSED");
      expect(breaker.getConsecutiveFailures()).toBe(4);
    });

    it("expires failures outside the 60-second rolling window", () => {
      const realNow = Date.now;
      let mockTime = 1000000;
      Date.now = jest.fn(() => mockTime);

      try {
        const breaker = new MtnCircuitBreaker({
          failureThreshold: 5,
          rollingWindowMs: 60_000,
        });

        breaker.recordFailure(new Error("fail 1"));
        breaker.recordFailure(new Error("fail 2"));
        breaker.recordFailure(new Error("fail 3"));
        expect(breaker.getConsecutiveFailures()).toBe(3);

        mockTime += 61_000;

        breaker.recordFailure(new Error("fail 4"));
        breaker.recordFailure(new Error("fail 5"));

        expect(breaker.getState()).toBe("CLOSED");
        expect(breaker.getConsecutiveFailures()).toBe(2);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe("Fail-Fast and Structured Graceful Fallback Error", () => {
    it("fails fast in OPEN state without calling the wrapped function", async () => {
      const breaker = new MtnCircuitBreaker({
        failureThreshold: 5,
        cooldownPeriodMs: 30_000,
      });
      breaker.trip();

      const action = jest.fn().mockResolvedValue({ success: true });
      const result = await breaker.execute(action);

      expect(action).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        provider: "mtn",
        error: {
          code: "CIRCUIT_BREAKER_OPEN",
          provider: "mtn",
          operation: "collection",
          message:
            "MTN MoMo collection circuit breaker is OPEN. Requests failing fast.",
          state: "OPEN",
          retryAfterMs: expect.any(Number),
        },
      });
    });

    it("returns accurate retryAfterMs based on remaining cooldown", () => {
      const realNow = Date.now;
      let mockTime = 2000000;
      Date.now = jest.fn(() => mockTime);

      try {
        const breaker = new MtnCircuitBreaker({
          cooldownPeriodMs: 30_000,
        });
        breaker.trip(mockTime);

        mockTime += 10_000;

        const fallback = breaker.buildFallbackResponse();
        expect(fallback.error.retryAfterMs).toBe(20_000);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe("Cooldown and HALF_OPEN Recovery Cycle", () => {
    it("transitions from OPEN to HALF_OPEN after cooldown period", () => {
      const realNow = Date.now;
      let mockTime = 3000000;
      Date.now = jest.fn(() => mockTime);

      try {
        const stateTransitions: string[] = [];
        const breaker = new MtnCircuitBreaker({
          cooldownPeriodMs: 30_000,
          onStateChange: (from, to) => stateTransitions.push(`${from}->${to}`),
        });

        breaker.trip(mockTime);
        expect(breaker.getState()).toBe("OPEN");

        mockTime += 29_000;
        expect(breaker.getState()).toBe("OPEN");

        mockTime += 1_000;
        expect(breaker.getState()).toBe("HALF_OPEN");
        expect(breaker.isHalfOpen()).toBe(true);
        expect(stateTransitions).toEqual(["CLOSED->OPEN", "OPEN->HALF_OPEN"]);
      } finally {
        Date.now = realNow;
      }
    });

    it("recovers to CLOSED when trial probe in HALF_OPEN succeeds", async () => {
      const realNow = Date.now;
      let mockTime = 4000000;
      Date.now = jest.fn(() => mockTime);

      try {
        const stateTransitions: string[] = [];
        const breaker = new MtnCircuitBreaker({
          cooldownPeriodMs: 20_000,
          onStateChange: (from, to) => stateTransitions.push(`${from}->${to}`),
        });

        breaker.trip(mockTime);
        mockTime += 20_000;
        expect(breaker.getState()).toBe("HALF_OPEN");

        const probeAction = jest
          .fn()
          .mockResolvedValue({ success: true, txId: "probe-1" });
        const result = await breaker.execute(probeAction);

        expect(probeAction).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ success: true, txId: "probe-1" });
        expect(breaker.getState()).toBe("CLOSED");
        expect(breaker.getConsecutiveFailures()).toBe(0);
        expect(stateTransitions).toEqual([
          "CLOSED->OPEN",
          "OPEN->HALF_OPEN",
          "HALF_OPEN->CLOSED",
        ]);
      } finally {
        Date.now = realNow;
      }
    });

    it("trips back to OPEN when trial probe in HALF_OPEN fails", async () => {
      const realNow = Date.now;
      let mockTime = 5000000;
      Date.now = jest.fn(() => mockTime);

      try {
        const stateTransitions: string[] = [];
        const breaker = new MtnCircuitBreaker({
          cooldownPeriodMs: 20_000,
          onStateChange: (from, to) => stateTransitions.push(`${from}->${to}`),
        });

        breaker.trip(mockTime);
        mockTime += 20_000;
        expect(breaker.getState()).toBe("HALF_OPEN");

        const probeAction = jest
          .fn()
          .mockRejectedValue(new Error("upstream still failing"));
        await expect(breaker.execute(probeAction)).rejects.toThrow(
          "upstream still failing",
        );

        expect(breaker.getState()).toBe("OPEN");
        expect(stateTransitions).toEqual([
          "CLOSED->OPEN",
          "OPEN->HALF_OPEN",
          "HALF_OPEN->OPEN",
        ]);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe("Prometheus Metrics Integration", () => {
    it("updates provider_circuit_breaker_state gauge and transition counter", async () => {
      const breaker = new MtnCircuitBreaker({
        provider: "mtn_test",
        operation: "collection_test",
        cooldownPeriodMs: 10_000,
      });

      expect(breaker.getState()).toBe("CLOSED");

      breaker.trip();
      const metricsTextOpen = await register.metrics();
      expect(metricsTextOpen).toContain(
        'provider_circuit_breaker_transitions_total{provider="mtn_test",operation="collection_test",state="open"}',
      );

      breaker.reset();
      const metricsTextClosed = await register.metrics();
      expect(metricsTextClosed).toContain(
        'provider_circuit_breaker_transitions_total{provider="mtn_test",operation="collection_test",state="closed"}',
      );
    });
  });

  describe("MtnService Integration with Collection Workflow", () => {
    it("delegates requestPayment to MTNProvider when circuit is CLOSED", async () => {
      const mockProvider = {
        requestPayment: jest.fn().mockResolvedValue({
          success: true,
          data: { status: "SUCCESSFUL" },
          referenceId: "ref-123",
        }),
        sendPayout: jest.fn(),
        sendBatchPayout: jest.fn(),
        getTransactionStatus: jest.fn(),
      } as unknown as MTNProvider;

      const mtnService = new MtnService({
        provider: mockProvider,
        circuitBreakerOptions: { failureThreshold: 5 },
      });

      const res = await mtnService.requestPayment("+237670000001", "5000");

      expect(res.success).toBe(true);
      expect((res as any).referenceId).toBe("ref-123");
      expect(mockProvider.requestPayment).toHaveBeenCalledWith(
        "+237670000001",
        "5000",
        undefined,
      );
      expect(mtnService.getCircuitState()).toBe("CLOSED");
    });

    it("fails fast in MtnService when circuit breaker is tripped to OPEN", async () => {
      const mockProvider = {
        requestPayment: jest
          .fn()
          .mockRejectedValue(new Error("MTN Gateway 504 Timeout")),
        sendPayout: jest.fn(),
        sendBatchPayout: jest.fn(),
        getTransactionStatus: jest.fn(),
      } as unknown as MTNProvider;

      const mtnService = new MtnService({
        provider: mockProvider,
        circuitBreakerOptions: {
          failureThreshold: 5,
          cooldownPeriodMs: 60_000,
        },
      });

      for (let i = 0; i < 5; i++) {
        await mtnService.requestPayment("+237670000001", "5000");
      }

      expect(mtnService.getCircuitState()).toBe("OPEN");
      expect(mockProvider.requestPayment).toHaveBeenCalledTimes(5);

      const failFastRes = await mtnService.requestPayment(
        "+237670000001",
        "5000",
      );

      expect(failFastRes.success).toBe(false);
      expect((failFastRes as any).error.code).toBe("CIRCUIT_BREAKER_OPEN");
      expect(mockProvider.requestPayment).toHaveBeenCalledTimes(5);
    });
  });
});
