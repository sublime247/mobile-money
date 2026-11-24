/**
 * IVMS 101 Travel Rule tests — issue #2466
 */

import {
  buildIVMS101Payload,
  buildIVMS101FromRecord,
  validateIVMS101Input,
  type IVMS101Payload,
} from "../ivms101";
import type { TravelRuleParty, TravelRuleRecord } from "../travelRule";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSender(overrides: Partial<TravelRuleParty> = {}): TravelRuleParty {
  return {
    name: "Alice Johnson",
    account: "GALICE123XYZ",
    address: "12 Main Street, Nairobi KE",
    dob: "1990-05-15",
    idNumber: "ID-KE-123456",
    ...overrides,
  };
}

function makeReceiver(
  overrides: Partial<TravelRuleParty> = {},
): TravelRuleParty {
  return {
    name: "Bob Kamau",
    account: "GBOB456ABC",
    address: "5 Business Park, Lagos NG",
    ...overrides,
  };
}

function makeRecord(overrides: Partial<TravelRuleRecord> = {}): TravelRuleRecord {
  return {
    id: "rec-001",
    transactionId: "txn-001",
    amount: 1500,
    currency: "USD",
    sender: makeSender(),
    receiver: makeReceiver(),
    originatingVasp: "Mobile Money Platform",
    beneficiaryVasp: "Partner VASP",
    createdAt: new Date("2026-10-19T10:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateIVMS101Input
// ---------------------------------------------------------------------------

describe("validateIVMS101Input", () => {
  it("passes with all mandatory fields present", () => {
    const { valid, errors } = validateIVMS101Input(makeSender(), makeReceiver());
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("fails when originator name is missing", () => {
    const { valid, errors } = validateIVMS101Input(
      makeSender({ name: "" }),
      makeReceiver(),
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("fails when originator account is missing", () => {
    const { valid, errors } = validateIVMS101Input(
      makeSender({ account: "" }),
      makeReceiver(),
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("account"))).toBe(true);
  });

  it("fails when originator has no address, idNumber, or dob", () => {
    const { valid, errors } = validateIVMS101Input(
      makeSender({ address: undefined, dob: undefined, idNumber: undefined }),
      makeReceiver(),
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("address"))).toBe(true);
  });

  it("passes when originator has only dob (no address or idNumber)", () => {
    const { valid } = validateIVMS101Input(
      makeSender({ address: undefined, idNumber: undefined }),
      makeReceiver(),
    );
    expect(valid).toBe(true);
  });

  it("passes when originator has only idNumber", () => {
    const { valid } = validateIVMS101Input(
      makeSender({ address: undefined, dob: undefined }),
      makeReceiver(),
    );
    expect(valid).toBe(true);
  });

  it("fails when beneficiary name is missing", () => {
    const { valid, errors } = validateIVMS101Input(
      makeSender(),
      makeReceiver({ name: "" }),
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("Beneficiary") && e.includes("name"))).toBe(true);
  });

  it("fails when beneficiary account is missing", () => {
    const { valid, errors } = validateIVMS101Input(
      makeSender(),
      makeReceiver({ account: "" }),
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("account"))).toBe(true);
  });

  it("collects all errors at once (not fail-fast)", () => {
    const { errors } = validateIVMS101Input(
      { name: "", account: "" } as TravelRuleParty,
      { name: "", account: "" } as TravelRuleParty,
    );
    expect(errors.length).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// buildIVMS101Payload
// ---------------------------------------------------------------------------

describe("buildIVMS101Payload", () => {
  it("produces a payload with IVMS101Version=2019-01-21", () => {
    const payload = buildIVMS101Payload(makeSender(), makeReceiver());
    expect(payload.IVMS101Version).toBe("2019-01-21");
  });

  it("sets originator account number", () => {
    const payload = buildIVMS101Payload(makeSender(), makeReceiver());
    expect(payload.originator.accountNumber).toContain("GALICE123XYZ");
  });

  it("sets beneficiary account number", () => {
    const payload = buildIVMS101Payload(makeSender(), makeReceiver());
    expect(payload.beneficiary.accountNumber).toContain("GBOB456ABC");
  });

  it("splits full name into primary/secondary identifiers", () => {
    const payload = buildIVMS101Payload(makeSender(), makeReceiver());
    const nameId =
      payload.originator.originatorPersons[0]?.naturalPerson?.name
        ?.nameIdentifiers[0];
    expect(nameId?.primaryIdentifier).toBe("Johnson");
    expect(nameId?.secondaryIdentifier).toBe("Alice");
    expect(nameId?.nameIdentifierType).toBe("LEGL");
  });

  it("handles single-word name gracefully", () => {
    const payload = buildIVMS101Payload(
      makeSender({ name: "Musa" }),
      makeReceiver(),
    );
    const nameId =
      payload.originator.originatorPersons[0]?.naturalPerson?.name
        ?.nameIdentifiers[0];
    expect(nameId?.primaryIdentifier).toBe("Musa");
    expect(nameId?.secondaryIdentifier).toBeUndefined();
  });

  it("includes geographic address when sender.address is set", () => {
    const payload = buildIVMS101Payload(makeSender(), makeReceiver());
    const address =
      payload.originator.originatorPersons[0]?.naturalPerson?.geographicAddress?.[0];
    expect(address).toBeDefined();
    expect(address?.addressType).toBe("GEOG");
    expect(address?.country).toBe("KE");
  });

  it("includes national identifier when sender.idNumber is set", () => {
    const payload = buildIVMS101Payload(makeSender(), makeReceiver());
    const natId =
      payload.originator.originatorPersons[0]?.naturalPerson
        ?.nationalIdentification;
    expect(natId?.nationalIdentifier).toBe("ID-KE-123456");
  });

  it("includes date of birth when sender.dob is set", () => {
    const payload = buildIVMS101Payload(makeSender(), makeReceiver());
    const dob =
      payload.originator.originatorPersons[0]?.naturalPerson
        ?.dateAndPlaceOfBirth;
    expect(dob?.dateOfBirth).toBe("1990-05-15");
  });

  it("sets VASP blocks when originatingVasp and beneficiaryVasp are provided", () => {
    const payload = buildIVMS101Payload(makeSender(), makeReceiver(), {
      originatingVasp: "Originator VASP",
      beneficiaryVasp: "Beneficiary VASP",
    });
    expect(payload.originatingVASP?.name).toBe("Originator VASP");
    expect(payload.beneficiaryVASP?.name).toBe("Beneficiary VASP");
  });

  it("omits VASP blocks when not provided", () => {
    const payload = buildIVMS101Payload(makeSender(), makeReceiver());
    expect(payload.originatingVASP).toBeUndefined();
    expect(payload.beneficiaryVASP).toBeUndefined();
  });

  it("throws in strict mode when mandatory fields are missing", () => {
    expect(() =>
      buildIVMS101Payload(
        { name: "", account: "", address: undefined, dob: undefined, idNumber: undefined },
        makeReceiver(),
      ),
    ).toThrow(/IVMS 101 validation failed/);
  });

  it("does NOT throw in non-strict mode even with missing fields", () => {
    expect(() =>
      buildIVMS101Payload(
        { name: "", account: "", address: undefined, dob: undefined, idNumber: undefined },
        makeReceiver(),
        { strict: false },
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildIVMS101FromRecord
// ---------------------------------------------------------------------------

describe("buildIVMS101FromRecord", () => {
  it("produces a valid IVMS 101 payload from a TravelRuleRecord", () => {
    const payload = buildIVMS101FromRecord(makeRecord());
    expect(payload.IVMS101Version).toBe("2019-01-21");
    expect(payload.originator.accountNumber[0]).toBe("GALICE123XYZ");
    expect(payload.beneficiary.accountNumber[0]).toBe("GBOB456ABC");
  });

  it("propagates VASP identifiers from the record", () => {
    const payload = buildIVMS101FromRecord(makeRecord());
    expect(payload.originatingVASP?.name).toBe("Mobile Money Platform");
    expect(payload.beneficiaryVASP?.name).toBe("Partner VASP");
  });

  it("omits VASP blocks when record has none", () => {
    const record = makeRecord({
      originatingVasp: undefined,
      beneficiaryVasp: undefined,
    });
    const payload = buildIVMS101FromRecord(record);
    expect(payload.originatingVASP).toBeUndefined();
    expect(payload.beneficiaryVASP).toBeUndefined();
  });
});
