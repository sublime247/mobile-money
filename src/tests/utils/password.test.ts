import { hashPassword, comparePassword } from "../../utils/password";
import { registerSchema } from "../../routes/auth";

describe("Password utils", () => {
  it("should hash a password and compare correctly", async () => {
    const password = "Test123!";
    const hash = await hashPassword(password);

    expect(typeof hash).toBe("string");
    expect(hash).not.toBe(password);

    const valid = await comparePassword(password, hash);
    expect(valid).toBe(true);

    const invalid = await comparePassword("wrongpass", hash);
    expect(invalid).toBe(false);
  });
});

describe("registerSchema password complexity", () => {
  const valid = { phone_number: "+237670000000", password: "Secure@Pass1!" };

  it("accepts a valid password", () => {
    expect(() => registerSchema.parse(valid)).not.toThrow();
  });

  it("rejects passwords shorter than 12 characters", () => {
    const result = registerSchema.safeParse({ ...valid, password: "Short1!" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/12 characters/);
  });

  it("rejects passwords without an uppercase letter", () => {
    const result = registerSchema.safeParse({
      ...valid,
      password: "nouppercase1!",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/uppercase/);
  });

  it("rejects passwords without a lowercase letter", () => {
    const result = registerSchema.safeParse({
      ...valid,
      password: "NOLOWERCASE1!",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/lowercase/);
  });

  it("rejects passwords without a special character", () => {
    const result = registerSchema.safeParse({
      ...valid,
      password: "NoSpecialChar1",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/special character/);
  });

  it("rejects missing phone_number", () => {
    const result = registerSchema.safeParse({ password: valid.password });
    expect(result.success).toBe(false);
  });
});
