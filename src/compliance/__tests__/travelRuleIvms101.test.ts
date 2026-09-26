import {
  buildIvms101Payload,
  validateIvms101Payload,
  travelRuleService,
} from "../travelRule";

describe("FATF Travel Rule IVMS101 Compliance Formatting Checks (#1563)", () => {
  const sender = {
    name: "Alice Smith",
    account: "GABCD111111111111111111111111111111111111111111111111111",
    address: "123 Main St, New York, NY",
    dob: "1985-06-15",
    idNumber: "ID987654321",
  };

  const receiver = {
    name: "Bob Jones",
    account: "GABCD222222222222222222222222222222222222222222222222222",
    address: "456 Market St, London, UK",
  };

  it("builds valid IVMS101 compliance metadata block structure", () => {
    const payload = buildIvms101Payload(sender, receiver, 2500, "USD");
    expect(payload.originator).toBeDefined();
    expect(payload.beneficiary).toBeDefined();
    expect(payload.transferHeader.amount).toBe("2500");
    expect(payload.originator.accountNumber[0]).toBe(sender.account);
    expect(payload.beneficiary.accountNumber[0]).toBe(receiver.account);
  });

  it("validates IVMS101 payload formatting correctly", () => {
    const payload = buildIvms101Payload(sender, receiver, 5000, "USD");
    const result = validateIvms101Payload(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects invalid IVMS101 payload missing originator account", () => {
    const invalidPayload = {
      originator: { originatorPersons: [] },
      beneficiary: { accountNumber: ["GBOB"] },
    };
    const result = validateIvms101Payload(invalidPayload);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("enforces Travel Rule compliance for qualifying transactions >= $1,000", () => {
    const input = {
      transactionId: "tx-12345",
      amount: 1500,
      currency: "USD",
      sender,
      receiver,
    };

    const res = travelRuleService.enforceCompliance(input);
    expect(res.compliant).toBe(true);
    expect(res.ivms101Payload).toBeDefined();
  });

  it("bypasses Travel Rule checks for sub-threshold transactions (< $1,000)", () => {
    const input = {
      transactionId: "tx-small",
      amount: 250,
      currency: "USD",
      sender,
      receiver,
    };

    const res = travelRuleService.enforceCompliance(input);
    expect(res.compliant).toBe(true);
  });
});
