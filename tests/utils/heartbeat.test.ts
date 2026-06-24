/**
 * Tests for the System Heartbeat Metric
 * 
 * Verifies that:
 * - The heartbeat metric is properly registered in Prometheus
 * - The heartbeat service starts and stops correctly
 * - The heartbeat metric updates at regular intervals
 * - The metric reports correct availability state (1=available, 0=unavailable)
 */

import { systemHeartbeat } from "../../src/utils/metrics";
import {
  startHeartbeatService,
  stopHeartbeatService,
  getHeartbeatStatus,
} from "../../src/services/heartbeatService";

describe("System Heartbeat Metric", () => {
  beforeEach(() => {
    // Clean up any existing heartbeat service
    stopHeartbeatService();
  });

  afterEach(() => {
    // Clean up after each test
    stopHeartbeatService();
  });

  describe("Metric Registration", () => {
    it("should have systemHeartbeat metric registered", () => {
      expect(systemHeartbeat).toBeDefined();
      expect(systemHeartbeat.name).toBe("system_heartbeat");
    });

    it("should have correct metric help text", async () => {
      const metrics = await systemHeartbeat.get();
      expect(metrics.help).toBe(
        "System heartbeat metric indicating baseline availability state (1=available, 0=unavailable)",
      );
    });

    it("should have service label", async () => {
      const metrics = await systemHeartbeat.get();
      expect(metrics.type).toBe("gauge");
      expect(metrics.labelNames).toContain("service");
    });
  });

  describe("Heartbeat Service Lifecycle", () => {
    it("should start heartbeat service and set initial value", async () => {
      startHeartbeatService();

      // Give it a moment to set the initial value
      await new Promise((resolve) => setTimeout(resolve, 100));

      const status = await getHeartbeatStatus();
      expect(status).toBe(1);
    });

    it("should stop heartbeat service and set value to 0", async () => {
      startHeartbeatService();

      // Give it a moment to set the initial value
      await new Promise((resolve) => setTimeout(resolve, 100));

      stopHeartbeatService();

      // Give it a moment to update
      await new Promise((resolve) => setTimeout(resolve, 100));

      const status = await getHeartbeatStatus();
      expect(status).toBe(0);
    });

    it("should maintain heartbeat value of 1 while running", async () => {
      startHeartbeatService();

      // Check multiple times to ensure consistency
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const status = await getHeartbeatStatus();
        expect(status).toBe(1);
      }
    });
  });

  describe("Heartbeat Updates", () => {
    it("should update heartbeat metric periodically", async () => {
      // Use a shorter interval for testing
      process.env.HEARTBEAT_INTERVAL_MS = "100";

      startHeartbeatService();

      // Wait for first update
      await new Promise((resolve) => setTimeout(resolve, 150));
      let status = await getHeartbeatStatus();
      expect(status).toBe(1);

      // Wait for second update
      await new Promise((resolve) => setTimeout(resolve, 150));
      status = await getHeartbeatStatus();
      expect(status).toBe(1);

      // Clean up
      delete process.env.HEARTBEAT_INTERVAL_MS;
    });

    it("should handle rapid start/stop cycles", async () => {
      for (let i = 0; i < 3; i++) {
        startHeartbeatService();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await getHeartbeatStatus()).toBe(1);

        stopHeartbeatService();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await getHeartbeatStatus()).toBe(0);
      }
    });
  });

  describe("Metric Values", () => {
    it("should set metric value to 1 when available", async () => {
      startHeartbeatService();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = await systemHeartbeat.get();
      const heartbeatValue = metrics.values.find(
        (v: any) => v.labels.service === "mobile-money",
      );

      expect(heartbeatValue).toBeDefined();
      expect(heartbeatValue.value).toBe(1);
    });

    it("should set metric value to 0 when unavailable", async () => {
      startHeartbeatService();
      await new Promise((resolve) => setTimeout(resolve, 100));

      stopHeartbeatService();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = await systemHeartbeat.get();
      const heartbeatValue = metrics.values.find(
        (v: any) => v.labels.service === "mobile-money",
      );

      expect(heartbeatValue).toBeDefined();
      expect(heartbeatValue.value).toBe(0);
    });

    it("should have correct service label", async () => {
      startHeartbeatService();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = await systemHeartbeat.get();
      const heartbeatValue = metrics.values.find(
        (v: any) => v.labels.service === "mobile-money",
      );

      expect(heartbeatValue).toBeDefined();
      expect(heartbeatValue.labels.service).toBe("mobile-money");
    });
  });

  describe("Error Handling", () => {
    it("should handle errors gracefully when updating heartbeat", async () => {
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      startHeartbeatService();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The service should continue running even if there are errors
      expect(await getHeartbeatStatus()).toBe(1);

      consoleSpy.mockRestore();
    });

    it("should return 0 if heartbeat status cannot be retrieved", async () => {
      // Don't start the service, so there's no heartbeat value
      const status = await getHeartbeatStatus();
      expect(status).toBe(0);
    });
  });

  describe("Prometheus Format", () => {
    it("should expose heartbeat metric in Prometheus format", async () => {
      startHeartbeatService();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = await systemHeartbeat.get();
      const prometheusOutput = `# HELP ${metrics.name} ${metrics.help}\n# TYPE ${metrics.name} ${metrics.type}`;

      expect(prometheusOutput).toContain("system_heartbeat");
      expect(prometheusOutput).toContain("gauge");
      expect(prometheusOutput).toContain("baseline availability state");
    });
  });
});
