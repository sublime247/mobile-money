import { redact, isSensitiveKey, REDACTED } from "../../src/utils/redact";

describe("redact utility", () => {
  describe("isSensitiveKey", () => {
    it("should return true for sensitive keys", () => {
      expect(isSensitiveKey("password")).toBe(true);
      expect(isSensitiveKey("accessToken")).toBe(true);
      expect(isSensitiveKey("API_KEY")).toBe(true);
      expect(isSensitiveKey("X-Api-Key")).toBe(true);
      expect(isSensitiveKey("newPassword")).toBe(true);
      expect(isSensitiveKey("cvv")).toBe(true);
    });

    it("should return false for non-sensitive keys", () => {
      expect(isSensitiveKey("username")).toBe(false);
      expect(isSensitiveKey("email")).toBe(false);
      expect(isSensitiveKey("id")).toBe(false);
      expect(isSensitiveKey("status")).toBe(false);
    });
  });

  describe("redact", () => {
    it("should redact plain objects", () => {
      const input = {
        username: "johndoe",
        password: "secretpassword",
        nested: {
          token: "abc123token",
          public: "info"
        }
      };

      const result = redact(input);
      expect(result).toEqual({
        username: "johndoe",
        password: REDACTED,
        nested: {
          token: REDACTED,
          public: "info"
        }
      });
    });

    it("should redact arrays", () => {
      const input = [
        { password: "123", id: 1 },
        { token: "abc", id: 2 }
      ];

      const result = redact(input);
      expect(result).toEqual([
        { password: REDACTED, id: 1 },
        { token: REDACTED, id: 2 }
      ]);
    });

    it("should redact error objects", () => {
      const err = new Error("Something went wrong") as any;
      err.code = 500;
      err.password = "secret";

      const result: any = redact(err);
      expect(result.message).toBe("Something went wrong");
      expect(result.code).toBe(500);
      expect(result.password).toBe(REDACTED);
      expect(result.stack).toBeDefined();
    });

    it("should parse and redact stringified JSON", () => {
      const input = JSON.stringify({ password: "123", name: "John" });
      const result = redact(input);
      
      expect(typeof result).toBe("string");
      expect(JSON.parse(result as string)).toEqual({
        password: REDACTED,
        name: "John"
      });
    });

    it("should return primitives as-is", () => {
      expect(redact("regular string")).toBe("regular string");
      expect(redact(123)).toBe(123);
      expect(redact(true)).toBe(true);
      expect(redact(null)).toBe(null);
      expect(redact(undefined)).toBe(undefined);
    });
  });
});
