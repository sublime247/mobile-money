/**
 * Automated test for the ProviderHighErrorRate Prometheus alert rule.
 * Issue #2357
 *
 * These tests exercise the PromQL expression logic in pure TypeScript so they
 * run in CI without a live Prometheus instance.  Each test simulates a
 * time-series sample set, evaluates the ratio, and asserts whether the alert
 * threshold is breached.
 *
 * The alert expression (simplified for unit evaluation):
 *   rate(provider_http_requests_total{status_code=~"5.."}[5m])
 *   / rate(provider_http_requests_total[5m])  > 0.05
 */

// ---------------------------------------------------------------------------
// Helpers — simulate rate() over a fixed window
// ---------------------------------------------------------------------------

interface Sample {
  provider: string;
  status_code: string;
  /** Number of requests in the window (rate() * window) */
  count: number;
}

/**
 * Evaluates the ProviderHighErrorRate alert expression against the given
 * samples and returns the per-provider ratio map.
 *
 * For unit-test purposes we use total counts rather than per-second rates
 * because the proportional relationship is identical.
 */
function evaluateErrorRateAlert(
  samples: Sample[],
): Record<string, number> {
  const fivexxByProvider: Record<string, number> = {};
  const totalByProvider: Record<string, number> = {};

  for (const s of samples) {
    totalByProvider[s.provider] =
      (totalByProvider[s.provider] ?? 0) + s.count;

    if (/^5\d{2}$/.test(s.status_code)) {
      fivexxByProvider[s.provider] =
        (fivexxByProvider[s.provider] ?? 0) + s.count;
    }
  }

  const ratios: Record<string, number> = {};
  for (const provider of Object.keys(totalByProvider)) {
    const total = totalByProvider[provider];
    const errors = fivexxByProvider[provider] ?? 0;
    ratios[provider] = total > 0 ? errors / total : 0;
  }

  return ratios;
}

const ALERT_THRESHOLD = 0.05; // 5 %

function shouldFire(ratio: number): boolean {
  return ratio > ALERT_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProviderHighErrorRate alert rule", () => {
  describe("alert expression threshold evaluation", () => {
    it("does NOT fire when error rate is below 5 %", () => {
      const samples: Sample[] = [
        { provider: "mpesa", status_code: "200", count: 950 },
        { provider: "mpesa", status_code: "500", count: 40 }, // 4 %
      ];
      const ratios = evaluateErrorRateAlert(samples);
      expect(shouldFire(ratios["mpesa"])).toBe(false);
      expect(ratios["mpesa"]).toBeCloseTo(0.04);
    });

    it("fires when error rate is exactly at threshold (> 5 %)", () => {
      const samples: Sample[] = [
        { provider: "mpesa", status_code: "200", count: 940 },
        { provider: "mpesa", status_code: "500", count: 60 }, // 6 %
      ];
      const ratios = evaluateErrorRateAlert(samples);
      expect(shouldFire(ratios["mpesa"])).toBe(true);
      expect(ratios["mpesa"]).toBeCloseTo(0.06);
    });

    it("fires when error rate is 100 % (total outage)", () => {
      const samples: Sample[] = [
        { provider: "airtel", status_code: "502", count: 200 },
        { provider: "airtel", status_code: "503", count: 100 },
      ];
      const ratios = evaluateErrorRateAlert(samples);
      expect(shouldFire(ratios["airtel"])).toBe(true);
      expect(ratios["airtel"]).toBe(1);
    });

    it("does NOT fire when there are zero requests (avoids division-by-zero)", () => {
      const samples: Sample[] = [];
      const ratios = evaluateErrorRateAlert(samples);
      expect(ratios["mpesa"]).toBeUndefined();
    });

    it("does NOT fire when there are only 2xx responses", () => {
      const samples: Sample[] = [
        { provider: "orange", status_code: "200", count: 1000 },
        { provider: "orange", status_code: "201", count: 50 },
      ];
      const ratios = evaluateErrorRateAlert(samples);
      expect(shouldFire(ratios["orange"])).toBe(false);
      expect(ratios["orange"]).toBe(0);
    });

    it("evaluates each provider independently", () => {
      const samples: Sample[] = [
        { provider: "mpesa", status_code: "200", count: 990 },
        { provider: "mpesa", status_code: "500", count: 10 }, // 1 % — ok
        { provider: "airtel", status_code: "200", count: 800 },
        { provider: "airtel", status_code: "503", count: 200 }, // 20 % — fire
      ];
      const ratios = evaluateErrorRateAlert(samples);
      expect(shouldFire(ratios["mpesa"])).toBe(false);
      expect(shouldFire(ratios["airtel"])).toBe(true);
    });

    it("counts all 5xx codes as errors (500, 502, 503, 504)", () => {
      const samples: Sample[] = [
        { provider: "mtn", status_code: "200", count: 800 },
        { provider: "mtn", status_code: "500", count: 20 },
        { provider: "mtn", status_code: "502", count: 20 },
        { provider: "mtn", status_code: "503", count: 20 },
        { provider: "mtn", status_code: "504", count: 20 }, // 80 5xx / 880 total ≈ 9 %
      ];
      const ratios = evaluateErrorRateAlert(samples);
      expect(shouldFire(ratios["mtn"])).toBe(true);
      expect(ratios["mtn"]).toBeCloseTo(80 / 880);
    });

    it("does NOT count 4xx codes as errors", () => {
      const samples: Sample[] = [
        { provider: "mpesa", status_code: "200", count: 900 },
        { provider: "mpesa", status_code: "400", count: 50 },
        { provider: "mpesa", status_code: "404", count: 50 }, // 100 4xx — not errors
      ];
      const ratios = evaluateErrorRateAlert(samples);
      expect(shouldFire(ratios["mpesa"])).toBe(false);
      expect(ratios["mpesa"]).toBe(0);
    });

    it("fires at exactly 5.1 % error rate", () => {
      const samples: Sample[] = [
        { provider: "wave", status_code: "200", count: 949 },
        { provider: "wave", status_code: "500", count: 51 }, // 51/1000 = 5.1 %
      ];
      const ratios = evaluateErrorRateAlert(samples);
      expect(shouldFire(ratios["wave"])).toBe(true);
    });
  });

  describe("alert metadata", () => {
    it("alert rule YAML specifies severity: critical", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const yamlPath = path.join(
        process.cwd(),
        "monitoring",
        "alerts.yml",
      );
      const content = fs.readFileSync(yamlPath, "utf-8");
      expect(content).toMatch(/severity:\s*critical/);
    });

    it("alert rule YAML contains runbook_url annotation", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const yamlPath = path.join(
        process.cwd(),
        "monitoring",
        "alerts.yml",
      );
      const content = fs.readFileSync(yamlPath, "utf-8");
      expect(content).toMatch(/runbook_url:/);
    });

    it("alert rule YAML references provider label in annotations", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const yamlPath = path.join(
        process.cwd(),
        "monitoring",
        "alerts.yml",
      );
      const content = fs.readFileSync(yamlPath, "utf-8");
      expect(content).toMatch(/\$labels\.provider/);
    });

    it("alert rule YAML is named ProviderHighErrorRate", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const yamlPath = path.join(
        process.cwd(),
        "monitoring",
        "alerts.yml",
      );
      const content = fs.readFileSync(yamlPath, "utf-8");
      expect(content).toMatch(/alert:\s*ProviderHighErrorRate/);
    });
  });
});
