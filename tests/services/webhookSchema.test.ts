import { parseWebhookPayload } from "../../src/services/webhookSchema";

describe("Webhook Schema Validator", () => {
  const validV1Payload = {
    version: "1.0.0",
    event_id: "evt_12345",
    event_type: "transaction.completed",
    timestamp: "2026-06-24T12:00:00Z",
    transaction_id: "txn_123",
    reference_number: "REF-001",
    transaction_type: "deposit",
    amount: "100.00",
    currency: "USD",
    phone_number: "+1234567890",
    provider: "mpesa",
    stellar_address: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
    status: "completed",
    created_at: "2026-06-24T11:59:00Z",
  };

  const validV2Payload = {
    version: "v2",
    event_id: "evt_12346",
    event_type: "dispute.created",
    timestamp: "2026-06-24T12:05:00Z",
    transaction_id: "txn_124",
    reference_number: "REF-002",
    transaction_type: "withdraw",
    amount: "50.00",
    currency: "USD",
    phone_number: "+1234567890",
    provider: "airtel",
    stellar_address: "GD5DJQDQKEZBDQZBH4ENLN5JTQAVLHKUL2QHYK3LTJY2J5N2Z5Q5K7",
    status: "pending",
    created_at: "2026-06-24T12:04:00Z",
    metadata: {
      reason: "chargeback",
    },
    client_id: "client_abc",
  };

  it("should successfully parse a valid V1 payload with version '1.0.0'", () => {
    const result = parseWebhookPayload(validV1Payload);
    expect(result.version).toBe("1.0.0");
    expect(result.event_id).toBe("evt_12345");
  });

  it("should successfully parse a valid V1 payload with version 'v1'", () => {
    const result = parseWebhookPayload({ ...validV1Payload, version: "v1" });
    expect(result.version).toBe("v1");
  });

  it("should successfully parse a valid V2 payload with version 'v2'", () => {
    const result = parseWebhookPayload(validV2Payload);
    expect(result.version).toBe("v2");
    expect((result as any).client_id).toBe("client_abc");
    expect((result as any).metadata).toEqual({ reason: "chargeback" });
  });

  it("should successfully parse a valid V2 payload with version '2.0.0'", () => {
    const result = parseWebhookPayload({ ...validV2Payload, version: "2.0.0" });
    expect(result.version).toBe("2.0.0");
  });

  it("should reject payload if version number is missing", () => {
    const { version, ...badPayload } = validV1Payload as any;
    expect(() => parseWebhookPayload(badPayload)).toThrow(
      "Invalid payload: version is missing or is not a string"
    );
  });

  it("should reject payload if version number is not a string", () => {
    const badPayload = { ...validV1Payload, version: 1 };
    expect(() => parseWebhookPayload(badPayload)).toThrow(
      "Invalid payload: version is missing or is not a string"
    );
  });

  it("should reject unsupported version numbers", () => {
    const badPayload = { ...validV1Payload, version: "3.0.0" };
    expect(() => parseWebhookPayload(badPayload)).toThrow(
      "Unsupported schema version: 3.0.0"
    );
  });

  it("should reject payload if it is not an object", () => {
    expect(() => parseWebhookPayload("invalid")).toThrow(
      "Invalid payload: payload must be an object"
    );
    expect(() => parseWebhookPayload(null)).toThrow(
      "Invalid payload: payload must be an object"
    );
  });

  it("should reject V1 payload with missing required fields", () => {
    const { amount, ...badPayload } = validV1Payload as any;
    expect(() => parseWebhookPayload(badPayload)).toThrow();
  });

  it("should reject V2 payload with missing required fields", () => {
    const { event_type, ...badPayload } = validV2Payload as any;
    expect(() => parseWebhookPayload(badPayload)).toThrow();
  });

  it("should reject V1 payload if field types are wrong", () => {
    const badPayload = { ...validV1Payload, timestamp: "not-a-date" };
    expect(() => parseWebhookPayload(badPayload)).toThrow();
  });
});
