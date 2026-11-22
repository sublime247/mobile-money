/**
 * Tests for JWT key rotation (issue #1971).
 *
 * Covers the acceptance criteria:
 * - Sign new tokens with the current primary secret.
 * - Verify incoming tokens against both primary and secondary secrets.
 * - Automatically deprecate the old secret after the grace window.
 */

process.env.JWT_SECRET = "primary-test-secret";
process.env.JWT_KEY_GRACE_PERIOD_HOURS = "24";

import jwt from "jsonwebtoken";
import {
  GRACE_PERIOD_MS,
  deprecateExpiredKeys,
  getActiveSigningKey,
  getVerificationKeys,
  resetStore,
  rotateKey,
} from "../jwtKeys";

describe("JWT key rotation (#1971)", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("grace window configuration", () => {
    it("defaults to a 24-hour grace window", () => {
      expect(24 * 60 * 60 * 1000).toBe(GRACE_PERIOD_MS);
    });
  });

  describe("signing", () => {
    it("signs new tokens with the current primary secret and embeds its kid", async () => {
      const { kid } = getActiveSigningKey();
      const token = jwt.sign({ userId: "u1" }, getActiveSigningKey().key, {
        header: { alg: "HS256", kid },
      });

      const header = jwt.decode(token, { complete: true })?.header;
      expect(header?.kid).toBe(kid);
      expect(kid).toBe("v1");
    });

    it("moves signing to the new key after rotation", async () => {
      const before = getActiveSigningKey().kid;
      const { newKid } = await rotateKey();

      expect(newKid).not.toBe(before);
      expect(getActiveSigningKey().kid).toBe(newKid);
    });
  });

  describe("verification", () => {
    it("verifies tokens signed with the primary key", async () => {
      const token = jwt.sign({ userId: "u2" }, getActiveSigningKey().key);
      expect(() => {
        const keys = getVerificationKeys();
        jwt.verify(token, keys[0].key);
      }).not.toThrow();
    });

    it("verifies tokens signed with the previous (secondary) key during the grace window", async () => {
      const oldKey = getActiveSigningKey().key;
      await rotateKey();

      const token = jwt.sign({ userId: "u3" }, oldKey);
      const keys = getVerificationKeys();

      // The old key is still present as a secondary verification key.
      expect(keys.map((k) => k.key)).toContain(oldKey);

      let verified = false;
      for (const { key } of keys) {
        try {
          jwt.verify(token, key);
          verified = true;
          break;
        } catch {
          // try next key
        }
      }
      expect(verified).toBe(true);
    });

    it("lists the primary key first for fast-path verification", async () => {
      await rotateKey();
      const keys = getVerificationKeys();
      expect(keys[0].kid).toBe(getActiveSigningKey().kid);
      expect(keys.length).toBe(2); // primary + one secondary in grace
    });
  });

  describe("deprecation", () => {
    it("deprecates the old secret after the grace window expires", async () => {
      const oldKid = getActiveSigningKey().kid;
      await rotateKey();

      // Still inside the grace window: both keys verify.
      expect(getVerificationKeys().map((k) => k.kid).sort()).toEqual(
        [oldKid, "v2"].sort(),
      );

      // Simulate the passage of the grace window.
      const after = Date.now() + GRACE_PERIOD_MS + 1000;
      const removed = deprecateExpiredKeys(after);

      expect(removed).toContain(oldKid);
      expect(getVerificationKeys().map((k) => k.kid)).toEqual(["v2"]);
    });

    it("keeps the primary key even when the sweeper runs", async () => {
      await rotateKey();
      const primaryKid = getActiveSigningKey().kid;

      deprecateExpiredKeys(Date.now() + GRACE_PERIOD_MS * 10);

      expect(getVerificationKeys().map((k) => k.kid)).toEqual([primaryKid]);
    });

    it("deprecates multiple stale secondary keys in one pass", async () => {
      await rotateKey(); // v2
      await rotateKey(); // v3
      const primaryKid = getActiveSigningKey().kid; // v3

      deprecateExpiredKeys(Date.now() + GRACE_PERIOD_MS * 10);

      const kids = getVerificationKeys().map((k) => k.kid);
      expect(kids).toEqual([primaryKid]);
    });
  });
});
