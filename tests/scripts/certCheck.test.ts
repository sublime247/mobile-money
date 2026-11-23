import { describe, it, expect, jest } from "@jest/globals";
import {
  CertResult,
  checkCertificateWithRetry,
  exitCodeFor,
  summarizeResults,
  EXIT_EXPIRING,
  EXIT_OK,
  EXIT_UNVERIFIED,
} from "../../scripts/cert_check";

function ok(domain: string, daysRemaining: number): CertResult {
  return {
    domain,
    valid: daysRemaining > 0,
    daysRemaining,
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuer: "Test CA",
    error: null,
  };
}

function failed(domain: string, error = "getaddrinfo ENOTFOUND"): CertResult {
  return {
    domain,
    valid: false,
    daysRemaining: null,
    expiresAt: null,
    issuer: null,
    error,
  };
}

describe("scripts/cert_check", () => {
  describe("summarizeResults", () => {
    it("names the expiring domains instead of leaving the list empty", () => {
      const summary = summarizeResults(
        [ok("api.example.com", 90), ok("pay.example.com", 12)],
        30,
      );

      expect(summary.domains).toEqual(["api.example.com", "pay.example.com"]);
      expect(summary.expiringDomains).toEqual(["pay.example.com"]);
      expect(summary.unreachableDomains).toEqual([]);
      expect(exitCodeFor(summary)).toBe(EXIT_EXPIRING);
    });

    it("treats a certificate exactly at the threshold and expired ones as expiring", () => {
      const summary = summarizeResults(
        [ok("edge.example.com", 30), ok("old.example.com", -3)],
        30,
      );

      expect(summary.expiringDomains).toEqual([
        "edge.example.com",
        "old.example.com",
      ]);
    });

    it("keeps unreachable domains separate from expiring ones", () => {
      const summary = summarizeResults(
        [ok("api.example.com", 90), failed("down.example.com")],
        30,
      );

      expect(summary.expiringDomains).toEqual([]);
      expect(summary.unreachableDomains).toEqual(["down.example.com"]);
      expect(exitCodeFor(summary)).toBe(EXIT_UNVERIFIED);
    });

    it("reports expiring certificates first when both problems are present", () => {
      const summary = summarizeResults(
        [ok("pay.example.com", 5), failed("down.example.com")],
        30,
      );

      expect(summary.expiringDomains).toEqual(["pay.example.com"]);
      expect(summary.unreachableDomains).toEqual(["down.example.com"]);
      expect(exitCodeFor(summary)).toBe(EXIT_EXPIRING);
    });

    it("exits 0 when every certificate is outside the threshold", () => {
      const summary = summarizeResults([ok("api.example.com", 90)], 30);

      expect(exitCodeFor(summary)).toBe(EXIT_OK);
    });
  });

  describe("checkCertificateWithRetry", () => {
    it("retries a transient connection error and returns the later success", async () => {
      const check = jest
        .fn<(domain: string) => Promise<CertResult>>()
        .mockResolvedValueOnce(failed("api.example.com", "ECONNRESET"))
        .mockResolvedValueOnce(ok("api.example.com", 60));

      const result = await checkCertificateWithRetry(
        "api.example.com",
        3,
        check,
        0,
      );

      expect(result.error).toBeNull();
      expect(result.daysRemaining).toBe(60);
      expect(check).toHaveBeenCalledTimes(2);
    });

    it("gives up after the configured attempts and returns the error", async () => {
      const check = jest
        .fn<(domain: string) => Promise<CertResult>>()
        .mockResolvedValue(failed("down.example.com", "ETIMEDOUT"));

      const result = await checkCertificateWithRetry(
        "down.example.com",
        3,
        check,
        0,
      );

      expect(result.error).toBe("ETIMEDOUT");
      expect(check).toHaveBeenCalledTimes(3);
    });

    it("does not re-check a certificate that was read successfully", async () => {
      const check = jest
        .fn<(domain: string) => Promise<CertResult>>()
        .mockResolvedValue(ok("api.example.com", 5));

      await checkCertificateWithRetry("api.example.com", 3, check, 0);

      expect(check).toHaveBeenCalledTimes(1);
    });
  });
});
