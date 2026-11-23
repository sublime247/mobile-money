import {
  validateSep31KycFields,
  getKycRequirementsForCountry,
  validateReceiverPhoneCountryMatch,
  validateSenderKycApproved,
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

    const result = validateSep31KycFields(
      fields,
      "sender_1",
      "receiver_1",
      "USA",
    );
    expect(result.valid).toBe(false);
    expect(result.missingSenderFields).toContain("last_name");
    expect(result.missingSenderFields).toContain("id_number");
    expect(result.missingReceiverFields).toContain("mobile_number");
    expect(result.error).toContain("Missing mandatory sender KYC fields");
  });
});

describe("SEP-31 Receiver Phone / Destination Country-Code Validation (#2263)", () => {
  it("passes when no destination country is supplied (nothing to match against)", () => {
    const result = validateReceiverPhoneCountryMatch(
      "+2348012345678",
      undefined,
    );
    expect(result.valid).toBe(true);
  });

  it("passes when no receiver mobile_number is supplied (format already checked elsewhere)", () => {
    const result = validateReceiverPhoneCountryMatch(undefined, "NGA");
    expect(result.valid).toBe(true);
  });

  it("passes when the receiver's phone country matches an ISO alpha-2 destination code", () => {
    const result = validateReceiverPhoneCountryMatch("+2348012345678", "NG");
    expect(result.valid).toBe(true);
  });

  it("passes when the receiver's phone country matches an ISO alpha-3 destination code", () => {
    const result = validateReceiverPhoneCountryMatch("+2348012345678", "NGA");
    expect(result.valid).toBe(true);
  });

  it("rejects when the receiver's phone country does not match the destination country", () => {
    const result = validateReceiverPhoneCountryMatch("+14155552671", "NGA"); // US number, NG destination
    expect(result.valid).toBe(false);
    expect(result.error).toContain("does not match destination country");
  });

  it("rejects a malformed phone number when a destination country is declared", () => {
    const result = validateReceiverPhoneCountryMatch(
      "not-a-phone-number",
      "US",
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not a valid E.164 phone number");
  });
});

describe("SEP-31 Sender SEP-12 KYC Status Validation (#2263)", () => {
  it("rejects when sender_id is missing", async () => {
    const result = await validateSenderKycApproved("", async () => null);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing sender_id");
  });

  it("rejects when no SEP-12 customer record is found for sender_id", async () => {
    const result = await validateSenderKycApproved(
      "sender-404",
      async () => null,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("No SEP-12 customer record found");
  });

  it("rejects an unverified ('none') KYC level", async () => {
    const result = await validateSenderKycApproved("sender-1", async () => ({
      kycLevel: "none",
    }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("kyc_level: none");
  });

  it("approves a 'basic' KYC level", async () => {
    const result = await validateSenderKycApproved("sender-1", async () => ({
      kycLevel: "basic",
    }));
    expect(result.valid).toBe(true);
  });

  it("approves a 'full' KYC level", async () => {
    const result = await validateSenderKycApproved("sender-1", async () => ({
      kycLevel: "full",
    }));
    expect(result.valid).toBe(true);
  });

  it("returns a descriptive error (not a thrown exception) when the lookup itself fails", async () => {
    const result = await validateSenderKycApproved("sender-1", async () => {
      throw new Error("connection refused");
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unable to verify sender KYC status");
  });
});
