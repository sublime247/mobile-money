import { describe, it, expect } from "vitest";
import { buildCorsHeaders } from "../index";

describe("buildCorsHeaders", () => {
  const BASE_HEADERS = {
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  describe("when ALLOWED_ORIGINS is empty (wildcard mode)", () => {
    const emptyOrigins = new Set<string>();

    it("returns wildcard origin when no allowlist configured", () => {
      const headers = buildCorsHeaders("https://example.com", emptyOrigins);
      expect(headers).toEqual({
        ...BASE_HEADERS,
        "Access-Control-Allow-Origin": "*",
      });
    });

    it("returns wildcard origin when request has no Origin header", () => {
      const headers = buildCorsHeaders(null, emptyOrigins);
      expect(headers).toEqual({
        ...BASE_HEADERS,
        "Access-Control-Allow-Origin": "*",
      });
    });
  });

  describe("when ALLOWED_ORIGINS has entries (allowlist mode)", () => {
    const allowedOrigins = new Set([
      "https://app.example.com",
      "https://admin.example.com",
    ]);

    it("reflects the origin when it matches the allowlist", () => {
      const headers = buildCorsHeaders(
        "https://app.example.com",
        allowedOrigins
      );
      expect(headers).toEqual({
        ...BASE_HEADERS,
        "Access-Control-Allow-Origin": "https://app.example.com",
        Vary: "Origin",
      });
    });

    it("reflects the second allowed origin", () => {
      const headers = buildCorsHeaders(
        "https://admin.example.com",
        allowedOrigins
      );
      expect(headers).toEqual({
        ...BASE_HEADERS,
        "Access-Control-Allow-Origin": "https://admin.example.com",
        Vary: "Origin",
      });
    });

    it("omits Access-Control-Allow-Origin when origin is not in allowlist", () => {
      const headers = buildCorsHeaders(
        "https://evil.com",
        allowedOrigins
      );
      expect(headers).toEqual(BASE_HEADERS);
      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("omits Access-Control-Allow-Origin when no Origin header present", () => {
      const headers = buildCorsHeaders(null, allowedOrigins);
      expect(headers).toEqual(BASE_HEADERS);
      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("handles origins with trailing spaces in env var", () => {
      const origins = new Set(["https://app.example.com"]);
      const headers = buildCorsHeaders(
        "https://app.example.com",
        origins
      );
      expect(headers["Access-Control-Allow-Origin"]).toBe(
        "https://app.example.com"
      );
    });
  });

  describe("edge cases", () => {
    it("treats http and https origins as distinct", () => {
      const origins = new Set(["https://example.com"]);
      const headers = buildCorsHeaders("http://example.com", origins);
      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("treats origins with different ports as distinct", () => {
      const origins = new Set(["https://example.com:3000"]);
      const headers = buildCorsHeaders("https://example.com", origins);
      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("handles empty string origin header", () => {
      const origins = new Set(["https://example.com"]);
      const headers = buildCorsHeaders("", origins);
      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("always includes base headers regardless of origin match", () => {
      const origins = new Set(["https://example.com"]);
      const headers = buildCorsHeaders("https://nope.com", origins);
      expect(headers["Access-Control-Allow-Methods"]).toBe("GET, HEAD, OPTIONS");
      expect(headers["Access-Control-Allow-Headers"]).toBe("Content-Type");
    });
  });
});
