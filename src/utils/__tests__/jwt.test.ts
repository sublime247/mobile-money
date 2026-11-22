/**
 * Tests for the utils/jwt verification utility (issue #1971).
 * Verifies tokens signed with primary and secondary secrets during
 * the rotation window and rejects tokens after deprecation.
 */

process.env.JWT_SECRET = "utils-jwt-test-secret";

import jwt from "jsonwebtoken";
import {
  generateToken,
  isTokenExpired,
  verifyToken,
} from "../../utils/jwt";
import {
  deprecateExpiredKeys,
  getActiveSigningKey,
  resetStore,
  rotateKey,
} from "../../auth/jwtKeys";

describe("utils/jwt rotation-aware verification (#1971)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("signs new tokens with the current primary secret", () => {
    const token = generateToken({ userId: "u1", email: "a@b.c" });
    const header = jwt.decode(token, { complete: true })?.header;
    expect(header?.kid).toBe(getActiveSigningKey().kid);
  });

  it("verifies tokens issued before a rotation (secondary key)", () => {
    const preRotationToken = generateToken({ userId: "u2", email: "x@y.z" });

    rotateKey();

    // Old token still verifies against the secondary key.
    expect(verifyToken(preRotationToken).userId).toBe("u2");
  });

  it("verifies new tokens after rotation (primary key)", () => {
    rotateKey();
    const token = generateToken({ userId: "u3", email: "n@o.p" });
    expect(verifyToken(token).userId).toBe("u3");
  });

  it("stops accepting tokens once the grace window has passed", () => {
    const preRotationToken = generateToken({ userId: "u4", email: "g@h.i" });

    rotateKey();
    // Force the grace window to have elapsed for the old key.
    deprecateExpiredKeys(Date.now() + 25 * 60 * 60 * 1000);

    expect(() => verifyToken(preRotationToken)).toThrow();
  });

  it("rejects tokens signed with an unknown secret", () => {
    const forged = jwt.sign({ userId: "evil" }, "attacker-secret");
    expect(() => verifyToken(forged)).toThrow();
  });

  it("isTokenExpired distinguishes expiry from invalid signatures", () => {
    // Expired well beyond the verifier's 60s clock tolerance.
    const expired = jwt.sign(
      { userId: "u5", email: "e@f.g" },
      getActiveSigningKey().key,
      { expiresIn: "-10m" },
    );
    expect(isTokenExpired(expired)).toBe(true);
    expect(isTokenExpired("not-a-token")).toBe(false);
  });
});
