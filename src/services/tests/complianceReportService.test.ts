/**
 * Unit tests — SAR XML export and FinCEN schema conformity
 * Issue #2469
 */

jest.mock("../../utils/logger", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  buildSARXml,
  validateSARXml,
  type SARFilingOptions,
} from "../sarExportService";
import type { Transaction } from "../../models/transaction";
import type { AMLAlert } from "../aml";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "txn-abc-123",
    referenceNumber: "REF-20261019-001",
    type: "deposit",
    amount: "50000",
    phoneNumber: "+237670000000",
    provider: "mtn",
    status: "completed" as any,
    userId: "user-001",
    createdAt: new Date("2026-10-19T10:00:00Z"),
    updatedAt: new Date("2026-10-19T10:01:00Z"),
    stellarAddress: "GABC123XYZ",
    currency: "XAF",
    ...overrides,
  } as Transaction;
}

function makeAlert(overrides: Partial<AMLAlert> = {}): AMLAlert {
  return {
    id: "alert-def-456",
    transactionId: "txn-abc-123",
    userId: "user-001",
    severity: "high",
    status: "pending_review",
    ruleHits: [
      {
        rule: "single_transaction_threshold",
        message: "Amount exceeds threshold",
        observed: 50000,
        threshold: 1000000,
      },
    ],
    reasons: ["Amount exceeds threshold"],
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildSARXml
// ---------------------------------------------------------------------------

describe("buildSARXml — FinCEN schema conformity", () => {
  it("returns a valid XML document with an XML declaration", () => {
    const { xml } = buildSARXml(makeTransaction(), makeAlert());
    expect(xml).toMatch(/^<\?xml/);
  });

  it("includes the FinCEN namespace", () => {
    const { xml } = buildSARXml(makeTransaction(), makeAlert());
    expect(xml).toContain("http://www.fincen.gov/base");
  });

  it("includes all required SAR elements", () => {
    const { xml } = buildSARXml(makeTransaction(), makeAlert());
    for (const el of [
      "EFilingBatchXML",
      "EFilingActivityXML",
      "ActivityType",
      "FilingInstitution",
      "SuspiciousActivity",
    ]) {
      expect(xml).toContain(`<${el}`);
    }
  });

  it("sets ActivityType to SAR", () => {
    const { xml } = buildSARXml(makeTransaction(), makeAlert());
    expect(xml).toContain("<ActivityType>SAR</ActivityType>");
  });

  it("embeds transaction ID and reference number", () => {
    const tx = makeTransaction({ id: "txn-unique-id", referenceNumber: "REF-XYZ" });
    const { xml } = buildSARXml(tx, makeAlert());
    expect(xml).toContain("txn-unique-id");
    expect(xml).toContain("REF-XYZ");
  });

  it("embeds alert ID and severity", () => {
    const alert = makeAlert({ id: "alert-999", severity: "high" });
    const { xml } = buildSARXml(makeTransaction(), alert);
    expect(xml).toContain("alert-999");
    expect(xml).toContain("high");
  });

  it("embeds subject information when provided", () => {
    const opts: SARFilingOptions = {
      subject: {
        firstName: "John",
        lastName: "Doe",
        ipAddress: "203.0.113.5",
        stellarAddress: "GDEF456",
      },
    };
    const { xml } = buildSARXml(makeTransaction(), makeAlert(), opts);
    expect(xml).toContain("John Doe");
    expect(xml).toContain("203.0.113.5");
    expect(xml).toContain("GDEF456");
  });

  it("includes narrative text", () => {
    const opts: SARFilingOptions = { narrative: "Custom narrative about suspicious activity." };
    const { xml } = buildSARXml(makeTransaction(), makeAlert(), opts);
    expect(xml).toContain("Custom narrative about suspicious activity.");
  });

  it("generates a default narrative when none provided", () => {
    const { xml } = buildSARXml(makeTransaction(), makeAlert());
    expect(xml).toContain("<NarrativeText>");
    expect(xml).toContain("txn-abc-123");
  });

  it("truncates narratives exceeding 10 000 characters", () => {
    const longNarrative = "A".repeat(12_000);
    const opts: SARFilingOptions = { narrative: longNarrative };
    const { xml } = buildSARXml(makeTransaction(), makeAlert(), opts);
    // NarrativeText value should not exceed 10 000 chars
    const match = xml.match(/<NarrativeText>([\s\S]*?)<\/NarrativeText>/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeLessThanOrEqual(10_000);
  });

  it("includes all triggered rules in TriggerRules", () => {
    const alert = makeAlert({
      ruleHits: [
        { rule: "rapid_structuring", message: "Rapid", observed: 3, threshold: 3 },
        { rule: "sanction_match", message: "Sanction", observed: 0.95, threshold: 0.85 },
      ],
    });
    const { xml } = buildSARXml(makeTransaction(), alert);
    expect(xml).toContain("rapid_structuring");
    expect(xml).toContain("sanction_match");
  });

  it("generates a unique filing reference for each call", () => {
    const { filingReference: ref1 } = buildSARXml(makeTransaction(), makeAlert());
    const { filingReference: ref2 } = buildSARXml(makeTransaction(), makeAlert());
    expect(ref1).not.toBe(ref2);
  });

  it("sets valid=true for well-formed output", () => {
    const { valid } = buildSARXml(makeTransaction(), makeAlert());
    expect(valid).toBe(true);
  });

  it("includes stellar address as transaction hash", () => {
    const tx = makeTransaction({ stellarAddress: "GHASH123ABC" });
    const { xml } = buildSARXml(tx, makeAlert());
    expect(xml).toContain("GHASH123ABC");
  });

  it("handles transaction with no stellarAddress gracefully", () => {
    const tx = makeTransaction({ stellarAddress: undefined });
    expect(() => buildSARXml(tx, makeAlert())).not.toThrow();
  });

  it("includes institution details when provided", () => {
    const opts: SARFilingOptions = {
      institution: {
        name: "Acme Bank",
        tin: "12-3456789",
        address: "123 Main St",
        city: "New York",
        state: "NY",
        zipCode: "10001",
        country: "US",
      },
    };
    const { xml } = buildSARXml(makeTransaction(), makeAlert(), opts);
    expect(xml).toContain("Acme Bank");
    expect(xml).toContain("12-3456789");
    expect(xml).toContain("New York");
  });
});

// ---------------------------------------------------------------------------
// validateSARXml
// ---------------------------------------------------------------------------

describe("validateSARXml", () => {
  it("returns valid=true for a well-formed SAR XML", () => {
    const { xml } = buildSARXml(makeTransaction(), makeAlert());
    const { valid, errors } = validateSARXml(xml);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("returns errors when required elements are missing", () => {
    const badXml = `<?xml version="1.0" encoding="UTF-8"?>
<EFilingBatchXML xmlns="http://www.fincen.gov/base">
  <SomeOtherElement/>
</EFilingBatchXML>`;
    const { valid, errors } = validateSARXml(badXml);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("EFilingActivityXML"))).toBe(true);
  });

  it("flags missing XML declaration", () => {
    const noDecl = `<EFilingBatchXML xmlns="http://www.fincen.gov/base">
  <EFilingActivityXML><ActivityType/><FilingInstitution/><SuspiciousActivity/></EFilingActivityXML>
</EFilingBatchXML>`;
    const { valid, errors } = validateSARXml(noDecl);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("XML declaration"))).toBe(true);
  });

  it("flags missing FinCEN namespace", () => {
    const noNs = `<?xml version="1.0" encoding="UTF-8"?>
<EFilingBatchXML>
  <EFilingActivityXML><ActivityType/><FilingInstitution/><SuspiciousActivity/></EFilingActivityXML>
</EFilingBatchXML>`;
    const { valid, errors } = validateSARXml(noNs);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("namespace"))).toBe(true);
  });

  it("returns all errors for a completely empty string", () => {
    const { valid, errors } = validateSARXml("");
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });
});
