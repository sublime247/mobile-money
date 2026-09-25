import { randomBytes } from "crypto";
import {
  decodeHashMemo,
  sep24DepositRequestSchema,
  toStellarMemo,
  validateMemo,
} from "../sep24";

const hash = randomBytes(32);
const base = {
  asset_code: "USDC",
  amount: "10",
  account: "GACCOUNT",
};

describe("validateMemo", () => {
  it.each([
    ["text", "exchange-user-42", null],
    ["text", "x".repeat(28), null],
    ["text", "x".repeat(29), "text memo must be at most 28 bytes"],
    // 10 x 3-byte characters = 30 bytes, over the limit despite 10 chars
    ["text", "€".repeat(10), "text memo must be at most 28 bytes"],
    ["id", "0", null],
    ["id", "18446744073709551615", null],
    [
      "id",
      "18446744073709551616",
      "id memo must be an unsigned 64-bit integer",
    ],
    ["id", "-1", "id memo must be an unsigned 64-bit integer"],
    ["id", "12abc", "id memo must be an unsigned 64-bit integer"],
    ["id", "1.5", "id memo must be an unsigned 64-bit integer"],
    ["hash", hash.toString("base64"), null],
    ["hash", hash.toString("hex"), null],
    [
      "hash",
      randomBytes(31).toString("base64"),
      "hash memo must be 32 bytes, base64-encoded",
    ],
    ["hash", "not a hash", "hash memo must be 32 bytes, base64-encoded"],
  ] as const)("%s memo %j -> %j", (type, memo, expected) => {
    expect(validateMemo(memo, type)).toBe(expected);
  });
});

describe("decodeHashMemo", () => {
  it("decodes base64 and hex to the same bytes", () => {
    expect(decodeHashMemo(hash.toString("base64"))).toEqual(hash);
    expect(decodeHashMemo(hash.toString("hex"))).toEqual(hash);
  });
});

describe("toStellarMemo", () => {
  it("builds each memo type", () => {
    expect(toStellarMemo("hello", "text").type).toBe("text");

    const id = toStellarMemo("123", "id");
    expect(id.type).toBe("id");
    expect(id.value).toBe("123");

    const h = toStellarMemo(hash.toString("base64"), "hash");
    expect(h.type).toBe("hash");
    expect(Buffer.from(h.value as Buffer)).toEqual(hash);
  });
});

describe("sep24DepositRequestSchema", () => {
  it("accepts a deposit without a memo", () => {
    const result = sep24DepositRequestSchema.parse(base);
    expect(result.memo).toBeUndefined();
    expect(result.memo_type).toBeUndefined();
  });

  it("accepts a memo with an explicit memo_type", () => {
    const result = sep24DepositRequestSchema.parse({
      ...base,
      memo: "123456",
      memo_type: "id",
    });
    expect(result).toMatchObject({ memo: "123456", memo_type: "id" });
  });

  it("defaults memo_type to text when only memo is sent", () => {
    const result = sep24DepositRequestSchema.parse({ ...base, memo: "abc" });
    expect(result.memo_type).toBe("text");
  });

  it("keeps unrelated fields and accepts a numeric amount", () => {
    const result = sep24DepositRequestSchema.parse({
      ...base,
      amount: 25,
      lang: "fr",
    });
    expect(result.amount).toBe("25");
    expect((result as Record<string, unknown>).lang).toBe("fr");
  });

  it.each([
    [{ memo_type: "id" }, "memo is required when memo_type is provided"],
    [
      { memo: "abc", memo_type: "id" },
      "id memo must be an unsigned 64-bit integer",
    ],
    [
      { memo: "abc", memo_type: "hash" },
      "hash memo must be 32 bytes, base64-encoded",
    ],
    [{ memo: "x".repeat(29) }, "text memo must be at most 28 bytes"],
    [{ memo: "", memo_type: "text" }, "memo must not be empty"],
  ])("rejects %j", (extra, message) => {
    const result = sep24DepositRequestSchema.safeParse({ ...base, ...extra });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].message).toBe(message);
  });

  it("rejects an unknown memo_type", () => {
    const result = sep24DepositRequestSchema.safeParse({
      ...base,
      memo: "abc",
      memo_type: "return",
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].path).toEqual(["memo_type"]);
  });

  describe("voucher_code (#1961)", () => {
    it("accepts a deposit without a voucher_code", () => {
      const result = sep24DepositRequestSchema.parse(base);
      expect(result.voucher_code).toBeUndefined();
    });

    it("accepts a deposit with a voucher_code", () => {
      const result = sep24DepositRequestSchema.parse({
        ...base,
        voucher_code: "VODAFONE-GH-VOUCH-1",
      });
      expect(result.voucher_code).toBe("VODAFONE-GH-VOUCH-1");
    });

    it("rejects an empty voucher_code", () => {
      const result = sep24DepositRequestSchema.safeParse({
        ...base,
        voucher_code: "",
      });
      expect(result.success).toBe(false);
      expect(result.error!.issues[0].message).toBe(
        "voucher_code must not be empty",
      );
    });
  });
});
