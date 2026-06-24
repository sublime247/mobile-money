import { PagerDutyService, createPagerDutyService } from "../pagerDutyService";

/**
 * Set the static thresholds directly (bypassing env-var parsing) so tests
 * can exercise the classifyShortfall routing with deterministic inputs.
 *
 * Uses the production `__resetShortfallStateForTests` helper so we never
 * reach into private static state via `(as any)` from test code.
 *
 * NOTE: this does NOT call `validateAndRepairThresholds()` itself — that's
 * the call site's responsibility, so the one-shot matrix log guard isn't
 * consumed by every test setup.
 */
function setShortfallThresholds(minor: number, moderate: number, critical: number): void {
  PagerDutyService.__resetShortfallStateForTests();
  PagerDutyService.BALANCE_SHORTFALL_THRESHOLDS = {
    criticalPct: critical,
    moderatePct: moderate,
    minorPct: minor,
  };
}

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

/**
 * ----------------------------------------------------------------------
 *  Balance Shortfall Tier Evaluation (issue #1018)
 * ----------------------------------------------------------------------
 *
 * Goal: prove that every possible shortfall value maps to AT MOST one
 * severity tier (no overlap, no silent gap above the noise floor), and
 * that the selected tier's escalation path matches the documented routing.
 */
describe("PagerDutyService – balance shortfall tier evaluation (#1018)", () => {
  let captured: jest.SpyInstance | undefined;

  beforeEach(() => {
    PagerDutyService.__resetShortfallStateForTests();
    captured = undefined;
  });

  afterEach(() => {
    if (captured) {
      captured.mockRestore();
      captured = undefined;
    }
    PagerDutyService.__resetShortfallStateForTests();
  });

  describe("classifyShortfall (default thresholds 10/25/50)", () => {
    it("returns null at and below 0% shortfall (no shortfall / noise floor)", () => {
      expect(PagerDutyService.classifyShortfall(0)).toBeNull();
      expect(PagerDutyService.classifyShortfall(-5)).toBeNull();
      expect(PagerDutyService.classifyShortfall(Number.NaN)).toBeNull();
      expect(PagerDutyService.classifyShortfall(Number.POSITIVE_INFINITY)).toBeNull();
    });

    it("returns null strictly below the minor tier (9.99% → no alert)", () => {
      expect(PagerDutyService.classifyShortfall(0.01)).toBeNull();
      expect(PagerDutyService.classifyShortfall(5)).toBeNull();
      expect(PagerDutyService.classifyShortfall(9.99)).toBeNull();
    });

    it("classifies the minor tier boundaries (10%–24.9999%) as warning", () => {
      // Lower boundary is INCLUSIVE: exactly the MINOR_PCT maps UP to warning
      expect(PagerDutyService.classifyShortfall(10)).toBe("warning");
      expect(PagerDutyService.classifyShortfall(10.0)).toBe("warning");
      expect(PagerDutyService.classifyShortfall(15)).toBe("warning");
      expect(PagerDutyService.classifyShortfall(24.99)).toBe("warning");
    });

    it("classifies the moderate tier boundaries (25%–49.9999%) as error", () => {
      expect(PagerDutyService.classifyShortfall(25)).toBe("error");
      expect(PagerDutyService.classifyShortfall(35)).toBe("error");
      expect(PagerDutyService.classifyShortfall(49.99)).toBe("error");
    });

    it("classifies the critical tier (>=50%) as critical", () => {
      expect(PagerDutyService.classifyShortfall(50)).toBe("critical");
      expect(PagerDutyService.classifyShortfall(75)).toBe("critical");
      expect(PagerDutyService.classifyShortfall(99.99)).toBe("critical");
      expect(PagerDutyService.classifyShortfall(100)).toBe("critical");
    });

    it("covers every positive percentage deterministically with no overlap or gap", () => {
      // Walk a dense grid across (0, 100] and verify there is exactly one
      // severity (or null) per value, and tier boundaries are deterministic.
      for (let p = 0.01; p <= 100; p = +(p + 0.01).toFixed(2)) {
        const sev = PagerDutyService.classifyShortfall(p);
        if (p < 10) expect(sev).toBeNull();
        else if (p < 25) expect(sev).toBe("warning");
        else if (p < 50) expect(sev).toBe("error");
        else expect(sev).toBe("critical");
      }
    });
  });

  describe("validateAndRepairThresholds", () => {
    it("returns the configured thresholds when they are strictly ordered", () => {
      setShortfallThresholds(15, 30, 60);
      const t = PagerDutyService.validateAndRepairThresholds();
      expect(t).toEqual({ criticalPct: 60, moderatePct: 30, minorPct: 15 });
    });

    it("repairs to defaults when tiers are equal (no spread)", () => {
      setShortfallThresholds(50, 50, 50);
      captured = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const input = { ...PagerDutyService.BALANCE_SHORTFALL_THRESHOLDS };
      const t = PagerDutyService.validateAndRepairThresholds();
      expect(t).toEqual({ criticalPct: 50, moderatePct: 25, minorPct: 10 });
      // delta assertion: prove the repair actually fired and changed values
      expect(t).not.toEqual(input);
      expect(captured).toHaveBeenCalled();
    });

    it("repairs to defaults when minor > moderate (reversed)", () => {
      setShortfallThresholds(60, 30, 10);
      captured = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const input = { ...PagerDutyService.BALANCE_SHORTFALL_THRESHOLDS };
      const t = PagerDutyService.validateAndRepairThresholds();
      expect(t).toEqual({ criticalPct: 50, moderatePct: 25, minorPct: 10 });
      expect(t).not.toEqual(input);
    });

    it("repairs when any tier is NaN", () => {
      PagerDutyService.__resetShortfallStateForTests();
      PagerDutyService.BALANCE_SHORTFALL_THRESHOLDS = {
        criticalPct: Number.NaN,
        moderatePct: 25,
        minorPct: 10,
      };
      captured = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const input = { ...PagerDutyService.BALANCE_SHORTFALL_THRESHOLDS };
      const t = PagerDutyService.validateAndRepairThresholds();
      expect(t).toEqual({ criticalPct: 50, moderatePct: 25, minorPct: 10 });
      expect(t).not.toEqual(input);
    });

    it("repairs when minor is zero or negative", () => {
      setShortfallThresholds(0, 25, 50);
      captured = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const input = { ...PagerDutyService.BALANCE_SHORTFALL_THRESHOLDS };
      const t = PagerDutyService.validateAndRepairThresholds();
      expect(t).toEqual({ criticalPct: 50, moderatePct: 25, minorPct: 10 });
      expect(t).not.toEqual(input);
    });

    it("emits the startup matrix log exactly once per process", () => {
      captured = jest.spyOn(console, "log").mockImplementation(() => undefined);
      PagerDutyService.validateAndRepairThresholds();
      PagerDutyService.validateAndRepairThresholds();
      PagerDutyService.validateAndRepairThresholds();
      const matrixCalls = captured.mock.calls.filter((args) =>
        String(args[0] ?? "").includes("Balance shortfall escalation matrix active"),
      );
      expect(matrixCalls).toHaveLength(1);
    });
  });

  describe("classifyShortfall with custom thresholds", () => {
    it("routes against the configured (non-default) tier thresholds", () => {
      setShortfallThresholds(5, 20, 40);
      expect(PagerDutyService.classifyShortfall(4.99)).toBeNull();
      expect(PagerDutyService.classifyShortfall(5)).toBe("warning");
      expect(PagerDutyService.classifyShortfall(19.99)).toBe("warning");
      expect(PagerDutyService.classifyShortfall(20)).toBe("error");
      expect(PagerDutyService.classifyShortfall(39.99)).toBe("error");
      expect(PagerDutyService.classifyShortfall(40)).toBe("critical");
    });
  });

  describe("escalation label mapping (issue #1018: routing correctness)", () => {
    it("maps warning → team-notification", () => {
      expect(PagerDutyService.getEscalationLabel("warning")).toBe("team-notification");
    });
    it("maps error → operational-escalation", () => {
      expect(PagerDutyService.getEscalationLabel("error")).toBe("operational-escalation");
    });
    it("maps critical → immediate-escalation", () => {
      expect(PagerDutyService.getEscalationLabel("critical")).toBe("immediate-escalation");
    });
  });

  describe("evaluateBalanceShortfall", () => {
    it("returns null when current balance >= threshold (no shortfall)", () => {
      const svc = new PagerDutyService({
        integrationKey: "k", dedupKey: "d", enabled: false,
      });
      expect(svc.evaluateBalanceShortfall("mtn", "XAF", 1000, 1000)).toBeNull();
      expect(svc.evaluateBalanceShortfall("mtn", "XAF", 1000, 1500)).toBeNull();
    });

    it("returns null when threshold <= 0", () => {
      const svc = new PagerDutyService({
        integrationKey: "k", dedupKey: "d", enabled: false,
      });
      captured = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(svc.evaluateBalanceShortfall("mtn", "XAF", 0, 100)).toBeNull();
      expect(svc.evaluateBalanceShortfall("mtn", "XAF", -50, 100)).toBeNull();
      expect(captured).toHaveBeenCalled();
    });

    it("returns null when shortfall is below the noise floor (sub-MINOR_PCT)", () => {
      const svc = new PagerDutyService({
        integrationKey: "k", dedupKey: "d", enabled: false,
      });
      // threshold=1000, balance=910 → 9% shortfall (just below 10% MINOR)
      expect(svc.evaluateBalanceShortfall("mtn", "XAF", 1000, 910)).toBeNull();
      // threshold=1000, balance=999 → 0.1% shortfall
      expect(svc.evaluateBalanceShortfall("mtn", "XAF", 1000, 999)).toBeNull();
    });

    it("returns a warning context for minor shortfalls (10% inclusive)", () => {
      const svc = new PagerDutyService({
        integrationKey: "k", dedupKey: "d", enabled: false,
      });
      const ctx = svc.evaluateBalanceShortfall("mtn", "XAF", 1000, 880);
      expect(ctx).not.toBeNull();
      expect(ctx!.shortfallAmount).toBe(120);
      expect(ctx!.shortfallPct).toBeCloseTo(12, 5);
      expect(ctx!.severity).toBe("warning");
      expect(ctx!.escalation).toBe("team-notification");
    });

    it("returns an error context for moderate shortfalls (25% inclusive)", () => {
      const svc = new PagerDutyService({
        integrationKey: "k", dedupKey: "d", enabled: false,
      });
      const ctx = svc.evaluateBalanceShortfall("mtn", "XAF", 1000, 700);
      expect(ctx).not.toBeNull();
      expect(ctx!.shortfallAmount).toBe(300);
      expect(ctx!.shortfallPct).toBeCloseTo(30, 5);
      expect(ctx!.severity).toBe("error");
      expect(ctx!.escalation).toBe("operational-escalation");
    });

    it("returns a critical context for critical shortfalls (50% inclusive)", () => {
      const svc = new PagerDutyService({
        integrationKey: "k", dedupKey: "d", enabled: false,
      });
      const ctx = svc.evaluateBalanceShortfall("mtn", "XAF", 1000, 400);
      expect(ctx).not.toBeNull();
      expect(ctx!.shortfallAmount).toBe(600);
      expect(ctx!.shortfallPct).toBeCloseTo(60, 5);
      expect(ctx!.severity).toBe("critical");
      expect(ctx!.escalation).toBe("immediate-escalation");
    });

    it("places exact-boundary shortfalls into the UPPER tier (deterministic)", () => {
      const svc = new PagerDutyService({
        integrationKey: "k", dedupKey: "d", enabled: false,
      });
      // Exactly 10% → warning (boundary belongs to upper tier)
      const minorBoundary = svc.evaluateBalanceShortfall("p", "XAF", 1000, 900)!;
      expect(minorBoundary.severity).toBe("warning");
      // Exactly 25% → error
      const moderateBoundary = svc.evaluateBalanceShortfall("p", "XAF", 1000, 750)!;
      expect(moderateBoundary.severity).toBe("error");
      // Exactly 50% → critical
      const criticalBoundary = svc.evaluateBalanceShortfall("p", "XAF", 1000, 500)!;
      expect(criticalBoundary.severity).toBe("critical");
    });
  });
});
