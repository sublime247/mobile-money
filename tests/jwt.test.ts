import { generateToken, verifyToken, isTokenExpired } from "../src/auth/jwt";

describe("JWT Authentication", () => {
  const testPayload = {
    userId: "test-user-123",
    email: "test@example.com",
  };

  beforeEach(() => {
    // Set test JWT_SECRET
    process.env.JWT_SECRET = "test-secret-key";
  });

  describe("generateToken", () => {
    it("should generate a valid JWT token", () => {
      const token = generateToken(testPayload);

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3); // JWT has 3 parts
    });

    it("should throw error when JWT_SECRET is not defined", () => {
      delete process.env.JWT_SECRET;

      expect(() => generateToken(testPayload)).toThrow(
        "JWT_SECRET is not defined in environment variables",
      );
    });
  });

  describe("verifyToken", () => {
    it("should verify a valid token and return payload", () => {
      const token = generateToken(testPayload);
      const decoded = verifyToken(token);

      expect(decoded.userId).toBe(testPayload.userId);
      expect(decoded.email).toBe(testPayload.email);
      expect(decoded.iat).toBeDefined();
      expect(decoded.exp).toBeDefined();
    });

    it("should throw error for expired token", () => {
      // Create token that's already expired
      const expiredToken = generateToken(testPayload);

      // Mock jwt.verify to simulate expired token
      const jwt = require("jsonwebtoken");
      const originalVerify = jwt.verify;
      jwt.verify = jest.fn().mockImplementation(() => {
        throw new jwt.TokenExpiredError("jwt expired", new Date());
      });

      expect(() => verifyToken(expiredToken)).toThrow("Token has expired");

      // Restore original function
      jwt.verify = originalVerify;
    });

    it("should throw error for invalid token", () => {
      const invalidToken = "invalid.token.here";

      expect(() => verifyToken(invalidToken)).toThrow("Invalid token");
    });

    it("should throw error when JWT_SECRET is not defined", () => {
      delete process.env.JWT_SECRET;

      expect(() => verifyToken("some-token")).toThrow(
        "JWT_SECRET is not defined in environment variables",
      );
    });
  });

  describe("isTokenExpired", () => {
    it("should return false for valid token", () => {
      const token = generateToken(testPayload);

      expect(isTokenExpired(token)).toBe(false);
    });

    it("should return true for expired token", () => {
      const expiredToken = generateToken(testPayload);

      // Mock jwt.verify to simulate expired token
      const jwt = require("jsonwebtoken");
      const originalVerify = jwt.verify;
      jwt.verify = jest.fn().mockImplementation(() => {
        throw new jwt.TokenExpiredError("jwt expired", new Date());
      });

      expect(isTokenExpired(expiredToken)).toBe(true);

      // Restore original function
      jwt.verify = originalVerify;
    });

    it("should return false for invalid token (not expired)", () => {
      const invalidToken = "invalid.token.here";

      expect(isTokenExpired(invalidToken)).toBe(false);
    });
  });
});
