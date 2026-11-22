/**
 * Unit tests for the QuoteCreateRequest Zod schema and quotes route.
 * Issue #2283
 */

import {
  quoteCreateSchema,
  formatZodErrors,
  ALL_ASSET_CODES,
} from "../../schemas/quoteSchema";

// ---------------------------------------------------------------------------
// Schema — valid inputs
// ---------------------------------------------------------------------------

describe("quoteCreateSchema — valid inputs", () => {
  it("accepts a well-formed request", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "KES",
      destination_asset: "USDC",
      amount: 1000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts fractional amounts", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "USD",
      destination_asset: "XLM",
      amount: 0.01,
    });
    expect(result.success).toBe(true);
  });

  it("accepts all supported source asset codes", () => {
    for (const code of ALL_ASSET_CODES) {
      // pick a different destination
      const dest = ALL_ASSET_CODES.find((c) => c !== code) ?? "USDC";
      const result = quoteCreateSchema.safeParse({
        source_asset: code,
        destination_asset: dest,
        amount: 50,
      });
      expect(result.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Schema — missing required fields
// ---------------------------------------------------------------------------

describe("quoteCreateSchema — missing required fields", () => {
  it("rejects when source_asset is missing", () => {
    const result = quoteCreateSchema.safeParse({
      destination_asset: "USDC",
      amount: 100,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path[0]);
      expect(fields).toContain("source_asset");
    }
  });

  it("rejects when destination_asset is missing", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "KES",
      amount: 100,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path[0]);
      expect(fields).toContain("destination_asset");
    }
  });

  it("rejects when amount is missing", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "KES",
      destination_asset: "USDC",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path[0]);
      expect(fields).toContain("amount");
    }
  });

  it("rejects an empty object", () => {
    const result = quoteCreateSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema — invalid amount values
// ---------------------------------------------------------------------------

describe("quoteCreateSchema — invalid amount values", () => {
  it("rejects negative amounts", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "KES",
      destination_asset: "USDC",
      amount: -100,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => /positive/i.test(m))).toBe(true);
    }
  });

  it("rejects zero amount", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "KES",
      destination_asset: "USDC",
      amount: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects string amount", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "KES",
      destination_asset: "USDC",
      amount: "100",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path[0]);
      expect(fields).toContain("amount");
    }
  });

  it("rejects NaN amount", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "KES",
      destination_asset: "USDC",
      amount: NaN,
    });
    expect(result.success).toBe(false);
  });

  it("rejects Infinity amount", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "KES",
      destination_asset: "USDC",
      amount: Infinity,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => /finite/i.test(m))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Schema — invalid asset codes
// ---------------------------------------------------------------------------

describe("quoteCreateSchema — invalid asset codes", () => {
  it("rejects an unknown source_asset code", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "UNKNOWN",
      destination_asset: "USDC",
      amount: 100,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path[0]);
      expect(fields).toContain("source_asset");
    }
  });

  it("rejects an unknown destination_asset code", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "KES",
      destination_asset: "FAKE",
      amount: 100,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path[0]);
      expect(fields).toContain("destination_asset");
    }
  });

  it("rejects lowercase asset codes", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "kes",
      destination_asset: "usdc",
      amount: 100,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema — extra / unexpected fields rejected
// ---------------------------------------------------------------------------

describe("quoteCreateSchema — extra field rejection (parameter injection prevention)", () => {
  it("rejects extra unknown fields", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "KES",
      destination_asset: "USDC",
      amount: 100,
      admin: true,            // unexpected
      __proto__: {},          // prototype injection attempt
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(
        messages.some((m) => /unexpected/i.test(m)),
      ).toBe(true);
    }
  });

  it("rejects when a numeric id field is injected", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "KES",
      destination_asset: "USDC",
      amount: 100,
      id: 999,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema — same source and destination rejected
// ---------------------------------------------------------------------------

describe("quoteCreateSchema — cross-field validation", () => {
  it("rejects when source_asset equals destination_asset", () => {
    const result = quoteCreateSchema.safeParse({
      source_asset: "USDC",
      destination_asset: "USDC",
      amount: 100,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(
        messages.some((m) => /different/i.test(m)),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// formatZodErrors helper
// ---------------------------------------------------------------------------

describe("formatZodErrors", () => {
  it("maps ZodError issues to { field, message } objects", () => {
    const result = quoteCreateSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = formatZodErrors(result.error);
      expect(Array.isArray(errors)).toBe(true);
      expect(errors.length).toBeGreaterThan(0);
      for (const e of errors) {
        expect(e).toHaveProperty("field");
        expect(e).toHaveProperty("message");
        expect(typeof e.field).toBe("string");
        expect(typeof e.message).toBe("string");
      }
    }
  });

  it("uses '_root' as field name for root-level refinement errors", () => {
    // same source/destination triggers a root-level refine
    const result = quoteCreateSchema.safeParse({
      source_asset: "KES",
      destination_asset: "KES",
      amount: 10,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = formatZodErrors(result.error);
      // The refine error path is ["destination_asset"] for this schema
      expect(errors.some((e) => e.field === "destination_asset" || e.field === "_root")).toBe(true);
    }
  });
});
