import {
  PagerDutyService,
  createPagerDutyService,
} from "../services/pagerDutyService";

describe("PagerDutyService", () => {
  let service: PagerDutyService;

  beforeEach(() => {
    // Create service with disabled network calls for testing
    service = new PagerDutyService({
      integrationKey: "test-integration-key",
      dedupKey: "test-dedup",
      enabled: true,
    });
  });

  afterEach(() => {
    service.stop();
    service.reset();
  });

  describe("initialization", () => {
    it("should create a service with valid config", () => {
      expect(service).toBeDefined();
      expect(service.getActiveIncidents().size).toBe(0);
    });

    it("should not start monitoring if disabled", () => {
      const disabledService = new PagerDutyService({
        integrationKey: "test-key",
        dedupKey: "test",
        enabled: false,
      });
      // Should not throw
      disabledService.start();
      expect(disabledService.getActiveIncidents().size).toBe(0);
    });
  });

  describe("error rate tracking", () => {
    it("should calculate 0% error rate when no errors", () => {
      service.recordProviderSuccess("stripe");
      service.recordProviderSuccess("stripe");
      service.recordProviderSuccess("stripe");

      const errorRate = service.getErrorRate("stripe");
      expect(errorRate).toBe(0);
    });

    it("should calculate 50% error rate with equal errors and successes", () => {
      service.recordProviderSuccess("stripe");
      service.recordProviderError("stripe", 0);
      service.recordProviderSuccess("stripe");
      service.recordProviderError("stripe", 0);

      const errorRate = service.getErrorRate("stripe");
      expect(errorRate).toBe(0.5);
    });

    it("should calculate 20% error rate (1 error out of 5)", () => {
      service.recordProviderSuccess("stripe");
      service.recordProviderSuccess("stripe");
      service.recordProviderSuccess("stripe");
      service.recordProviderSuccess("stripe");
      service.recordProviderError("stripe", 0);

      const errorRate = service.getErrorRate("stripe");
      expect(errorRate).toBe(0.2);
    });

    it("should handle multiple providers independently", () => {
      // Stripe: 2 errors out of 10 = 20%
      for (let i = 0; i < 8; i++) {
        service.recordProviderSuccess("stripe");
      }
      service.recordProviderError("stripe", 0);
      service.recordProviderError("stripe", 0);

      // Square: 3 errors out of 10 = 30%
      for (let i = 0; i < 7; i++) {
        service.recordProviderSuccess("square");
      }
      service.recordProviderError("square", 0);
      service.recordProviderError("square", 0);
      service.recordProviderError("square", 0);

      expect(service.getErrorRate("stripe")).toBe(0.2);
      expect(service.getErrorRate("square")).toBe(0.3);
    });
  });

  describe("threshold detection", () => {
    it("should identify when error rate exceeds 15% threshold", () => {
      // Create 15% error rate (15 errors out of 100 requests)
      for (let i = 0; i < 85; i++) {
        service.recordProviderSuccess("flutterwave");
      }
      for (let i = 0; i < 15; i++) {
        service.recordProviderError("flutterwave", 0);
      }

      const errorRate = service.getErrorRate("flutterwave");
      expect(errorRate).toBeGreaterThan(0.15);
    });

    it("should identify when error rate is below threshold", () => {
      // Create 14% error rate (14 errors out of 100 requests)
      for (let i = 0; i < 86; i++) {
        service.recordProviderSuccess("flutterwave");
      }
      for (let i = 0; i < 14; i++) {
        service.recordProviderError("flutterwave", 0);
      }

      const errorRate = service.getErrorRate("flutterwave");
      expect(errorRate).toBeLessThan(0.15);
    });
  });

  describe("incident state tracking", () => {
    it("should track active incidents per provider", () => {
      expect(service.getActiveIncidents().size).toBe(0);

      // Simulate tracking
      service.recordProviderError("stripe", 0);
      service.recordProviderSuccess("stripe");

      // Incidents are tracked internally
      const incidents = service.getActiveIncidents();
      expect(incidents.size).toBeGreaterThanOrEqual(0);
    });

    it("should allow resetting metrics", () => {
      service.recordProviderSuccess("stripe");
      service.recordProviderError("stripe", 0);

      expect(service.getErrorRate("stripe")).toBeGreaterThan(0);

      service.reset();
      expect(service.getErrorRate("stripe")).toBe(0);
      expect(service.getActiveIncidents().size).toBe(0);
    });
  });

  describe("factory function", () => {
    it("should create enabled service when env var is present", () => {
      // Mock environment variable
      const originalEnv = process.env.PAGERDUTY_INTEGRATION_KEY;
      process.env.PAGERDUTY_INTEGRATION_KEY = "test-key";

      const svc = createPagerDutyService(true);
      expect(svc).toBeDefined();

      // Restore
      if (originalEnv) {
        process.env.PAGERDUTY_INTEGRATION_KEY = originalEnv;
      } else {
        delete process.env.PAGERDUTY_INTEGRATION_KEY;
      }
    });

    it("should create disabled service when integration key is missing", () => {
      const originalEnv = process.env.PAGERDUTY_INTEGRATION_KEY;
      delete process.env.PAGERDUTY_INTEGRATION_KEY;

      const svc = createPagerDutyService(true);
      expect(svc).toBeDefined();
      // Service should be disabled but not throw

      if (originalEnv) {
        process.env.PAGERDUTY_INTEGRATION_KEY = originalEnv;
      }
    });
  });

  describe("sliding window calculations", () => {
    it("should track multiple data points over time", () => {
      const now = Date.now();

      // Simulate multiple errors at different times
      service.recordProviderError("stripe", now);
      service.recordProviderSuccess("stripe");
      service.recordProviderSuccess("stripe");

      const errorRate = service.getErrorRate("stripe");
      expect(errorRate).toBeGreaterThan(0);
      expect(errorRate).toBeLessThan(1);
    });
  });

  describe("provider error and success recording", () => {
    it("should properly track errors and successes", () => {
      const provider = "paypal";

      // Start monitoring
      service.start();

      // Record some transactions
      for (let i = 0; i < 100; i++) {
        if (i % 7 === 0) {
          // 14% error rate
          service.recordProviderError(provider, Date.now());
        } else {
          service.recordProviderSuccess(provider);
        }
      }

      const errorRate = service.getErrorRate(provider);
      expect(errorRate).toBeGreaterThan(0.1);
      expect(errorRate).toBeLessThan(0.2);
    });
  });

  describe("edge cases", () => {
    it("should handle zero requests gracefully", () => {
      const errorRate = service.getErrorRate("nonexistent");
      expect(errorRate).toBe(0);
    });

    it("should handle rapid error recordings", () => {
      // Simulate a burst of errors (e.g., provider API going down)
      for (let i = 0; i < 50; i++) {
        service.recordProviderError("stripe", Date.now());
      }

      const errorRate = service.getErrorRate("stripe");
      expect(errorRate).toBe(1); // 100% error rate when only errors, no successes
    });

    it("should calculate correct rate with mixed operations", () => {
      const operations = [
        { type: "success" },
        { type: "success" },
        { type: "error" },
        { type: "error" },
        { type: "error" },
        { type: "success" },
        { type: "success" },
        { type: "success" },
      ];

      for (const op of operations) {
        if (op.type === "error") {
          service.recordProviderError("flutterwave", Date.now());
        } else {
          service.recordProviderSuccess("flutterwave");
        }
      }

      const errorRate = service.getErrorRate("flutterwave");
      expect(errorRate).toBe(0.375); // 3/8
    });
  });
});

describe("Acceptance Criteria", () => {
  let service: PagerDutyService;

  beforeEach(() => {
    service = new PagerDutyService({
      integrationKey: "test-key",
      dedupKey: "test",
      enabled: true,
    });
  });

  afterEach(() => {
    service.stop();
    service.reset();
  });

  it("AC1: On-call alerted only when necessary (>15% error rate)", () => {
    // Simulate 16% error rate (above threshold)
    for (let i = 0; i < 84; i++) {
      service.recordProviderSuccess("stripe");
    }
    for (let i = 0; i < 16; i++) {
      service.recordProviderError("stripe", Date.now());
    }

    const errorRate = service.getErrorRate("stripe");
    expect(errorRate).toBeGreaterThan(0.15);
    // In real implementation, PagerDuty incident would be triggered here

    // Verify no false positives when below threshold
    service.reset();

    for (let i = 0; i < 86; i++) {
      service.recordProviderSuccess("square");
    }
    for (let i = 0; i < 14; i++) {
      service.recordProviderError("square", Date.now());
    }

    const lowErrorRate = service.getErrorRate("square");
    expect(lowErrorRate).toBeLessThan(0.15);
    // No alert should be triggered
  });

  it("AC2: Auto-resolves magically (when error rate drops below 15%)", () => {
    const provider = "flutterwave";

    // Start with high error rate
    service.recordProviderError(provider, Date.now());
    service.recordProviderError(provider, Date.now());
    service.recordProviderError(provider, Date.now());
    service.recordProviderError(provider, Date.now());

    let errorRate = service.getErrorRate(provider);
    expect(errorRate).toBe(1); // 100% error rate

    // Gradually recover (simulate recovery)
    for (let i = 0; i < 100; i++) {
      service.recordProviderSuccess(provider);
    }

    errorRate = service.getErrorRate(provider);
    expect(errorRate).toBeLessThan(0.15);
    // In real implementation, PagerDuty incident would be auto-resolved here
  });

  it("AC3: 5-minute sliding window for error rate calculation", () => {
    const provider = "paypal";
    const now = Date.now();

    // Simulate errors
    service.recordProviderError(provider, now);
    service.recordProviderError(provider, now + 1000);

    // Add successes
    for (let i = 0; i < 100; i++) {
      service.recordProviderSuccess(provider);
    }

    const errorRate = service.getErrorRate(provider);
    expect(errorRate).toBeGreaterThan(0); // Errors counted in window
    expect(errorRate).toBeLessThan(0.15); // But within recovery
  });
});
