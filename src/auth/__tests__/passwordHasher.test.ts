import argon2 from "argon2";
import bcrypt from "bcrypt";
import {
  ADMIN_ARGON2_OPTIONS,
  applyPepper,
  hashAdminPassword,
  isLegacyBcryptHash,
  verifyAdminPassword,
} from "../passwordHasher";

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const PASSWORD = "Correct-Horse-Battery-9";
const ORIGINAL_PEPPER = process.env.ADMIN_PASSWORD_PEPPER;

afterEach(() => {
  if (ORIGINAL_PEPPER === undefined) {
    delete process.env.ADMIN_PASSWORD_PEPPER;
  } else {
    process.env.ADMIN_PASSWORD_PEPPER = ORIGINAL_PEPPER;
  }
});

describe("hashAdminPassword", () => {
  beforeEach(() => {
    delete process.env.ADMIN_PASSWORD_PEPPER;
  });

  it("produces an Argon2id hash with the policy parameters", async () => {
    const hash = await hashAdminPassword(PASSWORD);

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain(
      `m=${ADMIN_ARGON2_OPTIONS.memoryCost},t=${ADMIN_ARGON2_OPTIONS.timeCost},p=${ADMIN_ARGON2_OPTIONS.parallelism}`,
    );
    expect(await argon2.verify(hash, PASSWORD)).toBe(true);
  });

  it("salts each hash so equal passwords never share a digest", async () => {
    const [a, b] = await Promise.all([
      hashAdminPassword(PASSWORD),
      hashAdminPassword(PASSWORD),
    ]);
    expect(a).not.toEqual(b);
  });

  it("rejects empty or non-string passwords", async () => {
    await expect(hashAdminPassword("")).rejects.toThrow("non-empty string");
    await expect(hashAdminPassword(undefined as unknown as string)).rejects.toThrow(
      "non-empty string",
    );
  });
});

describe("pepper handling", () => {
  it("keys the password with HMAC when a pepper is configured", () => {
    const peppered = applyPepper(PASSWORD, "pepper-one");

    expect(peppered).not.toBe(PASSWORD);
    expect(applyPepper(PASSWORD, "pepper-one")).toBe(peppered);
    expect(applyPepper(PASSWORD, "pepper-two")).not.toBe(peppered);
  });

  it("passes the password through unchanged when no pepper is set", () => {
    expect(applyPepper(PASSWORD, "")).toBe(PASSWORD);
  });

  it("requires the same pepper to verify a peppered hash", async () => {
    process.env.ADMIN_PASSWORD_PEPPER = "server-secret";
    const hash = await hashAdminPassword(PASSWORD);

    expect((await verifyAdminPassword(PASSWORD, hash)).valid).toBe(true);

    process.env.ADMIN_PASSWORD_PEPPER = "rotated-secret";
    expect((await verifyAdminPassword(PASSWORD, hash)).valid).toBe(false);

    delete process.env.ADMIN_PASSWORD_PEPPER;
    expect((await verifyAdminPassword(PASSWORD, hash)).valid).toBe(false);
  });
});

describe("verifyAdminPassword", () => {
  beforeEach(() => {
    delete process.env.ADMIN_PASSWORD_PEPPER;
  });

  it("accepts the right password and rejects the wrong one", async () => {
    const hash = await hashAdminPassword(PASSWORD);

    expect(await verifyAdminPassword(PASSWORD, hash)).toEqual({ valid: true });
    expect(await verifyAdminPassword("wrong-password", hash)).toEqual({ valid: false });
  });

  it("re-hashes a legacy bcrypt password to Argon2id after a successful check", async () => {
    const legacy = await bcrypt.hash(PASSWORD, 10);
    expect(isLegacyBcryptHash(legacy)).toBe(true);

    const result = await verifyAdminPassword(PASSWORD, legacy);

    expect(result.valid).toBe(true);
    expect(result.newHash?.startsWith("$argon2id$")).toBe(true);
    expect((await verifyAdminPassword(PASSWORD, result.newHash!)).newHash).toBeUndefined();
  });

  it("does not upgrade a legacy hash when the password is wrong", async () => {
    const legacy = await bcrypt.hash(PASSWORD, 10);

    expect(await verifyAdminPassword("nope", legacy)).toEqual({ valid: false });
  });

  it("upgrades an Argon2id hash whose parameters fall below policy", async () => {
    const weak = await argon2.hash(PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 4096,
      timeCost: 1,
      parallelism: 1,
    });

    const result = await verifyAdminPassword(PASSWORD, weak);

    expect(result.valid).toBe(true);
    expect(result.newHash).toBeDefined();
    expect(result.newHash).not.toEqual(weak);
  });

  it("fails closed on unknown, empty or corrupt hashes", async () => {
    expect(await verifyAdminPassword(PASSWORD, "")).toEqual({ valid: false });
    expect(await verifyAdminPassword(PASSWORD, "plaintext-password")).toEqual({ valid: false });
    expect(await verifyAdminPassword(PASSWORD, "$argon2id$v=19$garbage")).toEqual({
      valid: false,
    });
  });
});
