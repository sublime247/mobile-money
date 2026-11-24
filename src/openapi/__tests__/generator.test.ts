import { generateOpenAPIDocument } from "../generator";

describe("[Documentation] OpenAPI / Swagger Endpoint Specifications (#1861)", () => {
  it("should generate a valid OpenAPI 3.0.3 specification object", () => {
    const spec = generateOpenAPIDocument() as any;

    expect(spec).toBeDefined();
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toContain("Mobile Money Bridge API");
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  it("should include core endpoint tags in the specification", () => {
    const spec = generateOpenAPIDocument() as any;
    const tagNames = (spec.tags || []).map((t: any) => t.name);

    expect(tagNames).toContain("Auth");
    expect(tagNames).toContain("Transactions");
    expect(tagNames).toContain("Vaults");
    expect(tagNames).toContain("Contacts");
    expect(tagNames).toContain("Fees");
    expect(tagNames).toContain("KYC");
    expect(tagNames).toContain("HTLC");
    expect(tagNames).toContain("Prices");
    expect(tagNames).toContain("SEP-38 Quotes");
    expect(tagNames).toContain("SEP-30 Key Recovery");
  });

  it("should document components and schemas", () => {
    const spec = generateOpenAPIDocument() as any;
    expect(spec.components).toBeDefined();
    expect(spec.components.schemas).toBeDefined();
    expect(Object.keys(spec.components.schemas).length).toBeGreaterThan(0);
  });
});
