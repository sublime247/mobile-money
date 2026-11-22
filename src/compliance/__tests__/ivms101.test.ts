import {
  buildIvms101Payload,
  isTravelRuleRequired,
  validateDateOfBirth,
  validateCountryCode,
  TRAVEL_RULE_THRESHOLD_USD,
} from "../ivms101";

describe("IVMS 101 Travel Rule Builder", () => {
  it("should enforce threshold correctly", () => {
    expect(isTravelRuleRequired(999)).toBe(false);
    expect(isTravelRuleRequired(1000)).toBe(true);
    expect(isTravelRuleRequired(5000)).toBe(true);
    expect(TRAVEL_RULE_THRESHOLD_USD).toBe(1000);
  });

  it("should validate date of birth correctly", () => {
    expect(validateDateOfBirth("1990-05-15")).toBe(true);
    expect(validateDateOfBirth("invalid-date")).toBe(false);
    expect(validateDateOfBirth("2099-01-01")).toBe(false); // Future date
  });

  it("should validate country code format", () => {
    expect(validateCountryCode("US")).toBe(true);
    expect(validateCountryCode("KE")).toBe(true);
    expect(validateCountryCode("USA")).toBe(false);
    expect(validateCountryCode("u")).toBe(false);
  });

  it("should build valid IVMS 101 payload for natural persons", () => {
    const payload = buildIvms101Payload({
      originatorName: "Alice Smith",
      originatorAccount: "STELLAR-GA123",
      originatorAddress: {
        street: "123 Main St",
        city: "New York",
        postCode: "10001",
        country: "US",
      },
      originatorDob: "1988-12-01",
      originatorIdNumber: "ID987654",
      beneficiaryName: "Bob Jones",
      beneficiaryAccount: "STELLAR-GB456",
      beneficiaryAddress: {
        city: "Nairobi",
        country: "KE",
      },
      originatingVaspName: "MobileMoney Anchor Inc",
      beneficiaryVaspName: "Kenya Pay VASP",
      amount: 1500,
      currency: "USD",
    });

    expect(payload.originator.originatorPersons[0].naturalPerson?.name.primaryIdentifier).toBe("Alice Smith");
    expect(payload.originator.accountNumber).toContain("STELLAR-GA123");
    expect(payload.beneficiary.originatorPersons?.[0]?.naturalPerson?.name.primaryIdentifier || payload.beneficiary.beneficiaryPersons[0].naturalPerson?.name.primaryIdentifier).toBe("Bob Jones");
    expect(payload.originatingVasp?.legalPerson?.name.legalName).toBe("MobileMoney Anchor Inc");
    expect(payload.beneficiaryVasp?.legalPerson?.name.legalName).toBe("Kenya Pay VASP");
  });

  it("should reject invalid DOB with error", () => {
    expect(() => {
      buildIvms101Payload({
        originatorName: "Alice",
        originatorAccount: "ACC1",
        originatorDob: "bad-dob",
        beneficiaryName: "Bob",
        beneficiaryAccount: "ACC2",
        amount: 2000,
        currency: "USD",
      });
    }).toThrow("Invalid date of birth format");
  });
});
