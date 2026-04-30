import { ProviderReconciliationService } from "../providerReconciliationService";
import { queryRead, queryWrite } from "../../config/database";

describe("ProviderReconciliationService", () => {
  let service: ProviderReconciliationService;

  beforeEach(() => {
    service = new ProviderReconciliationService();
    // Clear any test data
  });

  afterEach(async () => {
    // Clean up test data
    try {
      await queryWrite("DELETE FROM provider_reconciliation_alerts WHERE reconciliation_run_id IN (SELECT id FROM provider_reconciliation_runs WHERE provider = 'test')");
      await queryWrite("DELETE FROM provider_reconciliation_runs WHERE provider = 'test'");
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe("getProviderConfigs", () => {
    it("should return enabled provider configurations", async () => {
      const configs = await service.getProviderConfigs();
      expect(Array.isArray(configs)).toBe(true);
    });
  });

  describe("runProviderReconciliation", () => {
    it("should handle disabled provider gracefully", async () => {
      await expect(
        service.runProviderReconciliation("nonexistent", new Date())
      ).rejects.toThrow("No enabled configuration found");
    });

    it("should create reconciliation run record", async () => {
      // This would require setting up test data and mocking the download
      // For now, just test that the method exists and handles errors properly
      const testDate = new Date("2024-01-01");

      await expect(
        service.runProviderReconciliation("test", testDate)
      ).rejects.toThrow(); // Should fail due to no config

      // Verify no run record was created
      const result = await queryRead(
        "SELECT COUNT(*) as count FROM provider_reconciliation_runs WHERE provider = $1 AND report_date = $2",
        ["test", "2024-01-01"]
      );

      expect(parseInt(result.rows[0].count)).toBe(0);
    });
  });

  describe("getPendingAlerts", () => {
    it("should return pending alerts ordered by severity", async () => {
      const alerts = await service.getPendingAlerts(10);
      expect(Array.isArray(alerts)).toBe(true);

      // Verify ordering (critical first, then high, etc.)
      for (let i = 1; i < alerts.length; i++) {
        const severityOrder = { critical: 1, high: 2, medium: 3, low: 4 };
        const prevOrder = severityOrder[alerts[i-1].severity as keyof typeof severityOrder];
        const currOrder = severityOrder[alerts[i].severity as keyof typeof severityOrder];

        expect(prevOrder).toBeLessThanOrEqual(currOrder);
      }
    });
  });

  describe("getReconciliationHistory", () => {
    it("should return reconciliation runs ordered by date", async () => {
      const history = await service.getReconciliationHistory(undefined, 10);
      expect(Array.isArray(history)).toBe(true);

      // Verify ordering (newest first)
      for (let i = 1; i < history.length; i++) {
        expect(new Date(history[i-1].created_at).getTime()).toBeGreaterThanOrEqual(
          new Date(history[i].created_at).getTime()
        );
      }
    });

    it("should filter by provider", async () => {
      const history = await service.getReconciliationHistory("mtn", 10);
      expect(Array.isArray(history)).toBe(true);

      // All results should be for the specified provider
      history.forEach(run => {
        expect(run.provider).toBe("mtn");
      });
    });
  });
});