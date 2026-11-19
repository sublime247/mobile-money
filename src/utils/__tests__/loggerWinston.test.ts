import { describe, expect, it } from "@jest/globals";
import { normalizeArgs, jsonFormat, prettyFormat, LOG_LEVELS } from "../logger";

/**
 * The structured logger was migrated from pino to Winston (#1851). These
 * tests pin the relaxed call-signature normalization and the JSON output
 * shape so the migration stays behaviour-compatible.
 */
describe("Winston structured logger (#1851)", () => {
  describe("normalizeArgs", () => {
    it("supports pino-style (fields, message) arguments", () => {
      expect(normalizeArgs([{ syncId: "s-1" }, "hello"])).toEqual({
        message: "hello",
        meta: { syncId: "s-1" },
      });
    });

    it("supports (message, fields) arguments", () => {
      expect(normalizeArgs(["hello", { syncId: "s-1" }])).toEqual({
        message: "hello",
        meta: { syncId: "s-1" },
      });
    });

    it("supports a bare message", () => {
      expect(normalizeArgs(["hello"])).toEqual({
        message: "hello",
        meta: {},
      });
    });

    it("supports fields-only arguments", () => {
      expect(normalizeArgs([{ event: "payment.failed" }])).toEqual({
        message: "",
        meta: { event: "payment.failed" },
      });
    });

    it("converts an Error second argument into meta.err", () => {
      const error = new Error("boom");
      const { message, meta } = normalizeArgs(["failed", error]);
      expect(message).toBe("failed");
      expect(meta.err).toBe(error);
    });

    it("uses the error message when the first argument is an Error", () => {
      const error = new Error("boom");
      expect(normalizeArgs([error]).message).toBe("boom");
    });
  });

  describe("jsonFormat", () => {
    it("emits uppercase level, msg, and structured fields", () => {
      const info: any = {
        level: "info",
        message: "Processing accounting sync operation",
        syncId: "s-1",
        platform: "xero",
      };
      const transformed = jsonFormat.transform(info);
      const line = transformed[Symbol.for("message")] as string;
      const parsed = JSON.parse(line);

      expect(parsed.level).toBe("INFO");
      expect(parsed.msg).toBe("Processing accounting sync operation");
      expect(parsed.syncId).toBe("s-1");
      expect(parsed.platform).toBe("xero");
      expect(parsed.service).toBeTruthy();
      expect(parsed.instance_id).toBeTruthy();
      expect(typeof parsed.time).toBe("string");
    });

    it("scrubs PII from the emitted JSON line", () => {
      const info: any = {
        level: "error",
        message: "user signup",
        email: "alice@example.com",
        phoneNumber: "+12025551234",
      };
      const transformed = jsonFormat.transform(info);
      const line = transformed[Symbol.for("message")] as string;
      const parsed = JSON.parse(line);

      expect(parsed.email).toBe("[REDACTED]");
      expect(parsed.phoneNumber).toBe("+1*****234");
      expect(line).not.toContain("alice@example.com");
      expect(line).not.toContain("+12025551234");
    });

    it("masks identifiers in pretty messages and nested Error metadata", () => {
      const info = {
        level: "error",
        [Symbol.for("level")]: "error",
        message: "Payment for +254712345123",
        err: new Error("ID number=12345678"),
        payer: { bankAccount: ["001234567890"] },
      };
      const transformed = prettyFormat.transform(info);
      const line = transformed[Symbol.for("message")] as string;
      expect(line).toContain("+254*****123");
      expect(line).toContain("ID number=[REDACTED]");
      expect(line).not.toContain("001234567890");
    });

    it("serializes Error metadata with name, message, and stack", () => {
      const info: any = {
        level: "error",
        message: "sync failed",
        err: new Error("provider outage"),
      };
      const transformed = jsonFormat.transform(info);
      const line = transformed[Symbol.for("message")] as string;
      const parsed = JSON.parse(line);

      expect(parsed.err.message).toBe("provider outage");
      expect(parsed.err.name).toBe("Error");
      expect(typeof parsed.err.stack).toBe("string");
    });
  });

  it("defines severity-ordered custom levels including security and audit", () => {
    expect(LOG_LEVELS.error).toBeLessThan(LOG_LEVELS.warn);
    expect(LOG_LEVELS.warn).toBeLessThan(LOG_LEVELS.security);
    expect(LOG_LEVELS.security).toBeLessThan(LOG_LEVELS.info);
    expect(LOG_LEVELS.info).toBeLessThan(LOG_LEVELS.debug);
    expect(LOG_LEVELS.debug).toBeLessThan(LOG_LEVELS.trace);
    expect(LOG_LEVELS.audit).toBeDefined();
  });
});
