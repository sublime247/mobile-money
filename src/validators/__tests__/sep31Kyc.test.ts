import {
  validateSep31KycFields,
  getKycRequirementsForCountry,
} from "../sep31";

describe("SEP-31 Strict Sender & Receiver KYC Validation (#1945)", () => {
  it("returns country-specific KYC requirements", () => {
    const usaReq = getKycRequirementsForCountry("USA");
    expect(usaReq.senderRequired).toContain("address");
    expect(usaReq.senderRequired).toContain("postal_code");

    const ngaReq = getKycRequirementsForCountry("NGA");
    expect(ngaReq.senderRequired).toContain("mobile_number");
  });

  it("passes validation when all required sender and receiver KYC fields are present", () => {
    const fields = {
      sender: {
        first_name: "Alice",
        last_name: "Smith",
        id_number: "ID12345678",
      },
      receiver: {
        first_name: "Bob",
        last_name: "Jones",
        mobile_number: "+2348012345678",
      },
    };

    const result = validateSep31KycFields(fields, "sender_1", "receiver_1");
    expect(result.valid).toBe(true);
    expect(result.missingSenderFields).toHaveLength(0);
    expect(result.missingReceiverFields).toHaveLength(0);
  });

  it("rejects validation when mandatory sender or receiver fields are missing", () => {
    const fields = {
      sender: {
        first_name: "Alice",
        // missing last_name & id_number
      },
      receiver: {
        first_name: "Bob",
        // missing mobile_number
      },
    };

    const result = validateSep31KycFields(fields, "sender_1", "receiver_1", "USA");
    expect(result.valid).toBe(false);
    expect(result.missingSenderFields).toContain("last_name");
    expect(result.missingSenderFields).toContain("id_number");
    expect(result.missingReceiverFields).toContain("mobile_number");
    expect(result.error).toContain("Missing mandatory sender KYC fields");
  });
});
