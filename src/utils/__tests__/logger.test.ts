import { scrubLogOutput, PII_USER_FIELDS } from "../../utils/logger";

describe("scrubLogOutput — PII and secret sanitization (#1648)", () => {
  /* ------------------------------------------------------------------ */
  /*  Base64 tokens (tests regex for dot-separated base64url pattern)    */
  /* ------------------------------------------------------------------ */

  it("redacts dot-separated base64url token patterns", () => {
    // Build a test string that matches the JWT regex without containing
    // a literal JWT. The regex is /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g
    const parts = [
      String.fromCharCode(101, 121, 74) + "headerdata",
      String.fromCharCode(101, 121, 74) + "payloaddata",
      "signaturedata",
    ];
    const token = parts.join(".");
    const result = scrubLogOutput(`Token: ${token}`);
    expect(result).not.toContain("headerdata");
    expect(result).not.toContain("payloaddata");
    expect(result).toContain("[REDACTED]");
  });

  /* ------------------------------------------------------------------ */
  /*  Hex-encoded private keys                                          */
  /* ------------------------------------------------------------------ */

  it("redacts 64+ character hex strings (likely private keys)", () => {
    // Constructed from repeating low-entropy hex chars
    const hexKey = "ef".repeat(32);
    const result = scrubLogOutput(`key=${hexKey}`);
    expect(result).not.toContain("ef".repeat(12));
    expect(result).toContain("[REDACTED]");
  });

  it("does not redact short hex strings (non-secret identifiers)", () => {
    const shortHex = "a1b2c3d4";
    const result = scrubLogOutput(`id=${shortHex}`);
    expect(result).toContain(shortHex);
  });

  /* ------------------------------------------------------------------ */
  /*  Base64-encoded secrets                                             */
  /* ------------------------------------------------------------------ */

  it("redacts long base64 strings (potential encrypted payloads)", () => {
    const b64 = "QUJDRA==FAKEBASE64STRINGFORTESTINGONLYNOTREALSECRET";
    const result = scrubLogOutput(`data=${b64}`);
    expect(result).not.toContain("FAKEBASE64STRINGFORTESTINGONLY");
    expect(result).toContain("[REDACTED]");
  });

  /* ------------------------------------------------------------------ */
  /*  Stellar addresses                                                  */
  /* ------------------------------------------------------------------ */

  it("redacts Stellar public addresses (G...)", () => {
    const address = "G" + "A".repeat(55);
    const result = scrubLogOutput(`address=${address}`);
    expect(result).not.toContain("G" + "A".repeat(10));
    expect(result).toContain("[REDACTED]");
  });

  /* ------------------------------------------------------------------ */
  /*  Stellar secret keys                                                */
  /* ------------------------------------------------------------------ */

  it("redacts Stellar secret keys (S...)", () => {
    const secret = "S" + "A".repeat(55);
    const result = scrubLogOutput(`secret=${secret}`);
    expect(result).not.toContain("S" + "A".repeat(10));
    expect(result).toContain("[REDACTED]");
  });

  /* ------------------------------------------------------------------ */
  /*  Stellar transaction hash (64 hex chars)                            */
  /* ------------------------------------------------------------------ */

  it("redacts 64-char hex strings (likely transaction hashes)", () => {
    const txHash = "ff".repeat(32);
    const result = scrubLogOutput(`tx=${txHash}`);
    expect(result).toContain("[REDACTED]");
  });

  /* ------------------------------------------------------------------ */
  /*  Bearer tokens                                                      */
  /* ------------------------------------------------------------------ */

  it("redacts Bearer tokens", () => {
    const result = scrubLogOutput(
      "Authorization: Bearer some-random-token-value-here",
    );
    expect(result).not.toContain("some-random-token-value-here");
    expect(result).toContain("[REDACTED]");
  });

  /* ------------------------------------------------------------------ */
  /*  Email addresses                                                    */
  /* ------------------------------------------------------------------ */

  it("redacts email addresses", () => {
    const result = scrubLogOutput("user email is fakeuser@example.com");
    expect(result).not.toContain("fakeuser@example.com");
    expect(result).toContain("[REDACTED]");
  });

  /* ------------------------------------------------------------------ */
  /*  Phone numbers (E.164)                                              */
  /* ------------------------------------------------------------------ */

  it("redacts international phone numbers", () => {
    const result = scrubLogOutput("phone: +12025551234");
    expect(result).toBe("phone: +1*****234");
  });

  /* ------------------------------------------------------------------ */
  /*  PII field patterns in key=value format                             */
  /* ------------------------------------------------------------------ */

  it("redacts PII fields in key=value format", () => {
    const result = scrubLogOutput("email=fakeuser@example.com firstName=John");
    expect(result).toContain("email=[REDACTED]");
    expect(result).toContain("firstName=[REDACTED]");
  });

  /* ------------------------------------------------------------------ */
  /*  Stack trace containing sensitive data                              */
  /* ------------------------------------------------------------------ */

  it("redacts sensitive values from simulated stack trace error messages", () => {
    const fakeAddr = "G" + "X".repeat(55);
    const stackTrace = [
      `Error: transaction failed for account ${fakeAddr}`,
      "    at submitTransaction (/app/src/services/stellar.ts:120:15)",
    ].join("\n");
    const result = scrubLogOutput(stackTrace);
    expect(result).not.toContain("G" + "X".repeat(10));
    expect(result).toContain("[REDACTED]");
  });

  /* ------------------------------------------------------------------ */
  /*  Nested object containing PII (simulates logger.error({...}))       */
  /* ------------------------------------------------------------------ */

  it("redacts PII from serialized JSON objects in log messages", () => {
    const logObject = JSON.stringify({
      event: "payment.failed",
      user: { email: "fakeuser@example.com", phone: "+12025551234" },
      error: { message: "insufficient balance" },
    });
    const result = scrubLogOutput(logObject);
    expect(result).not.toContain("fakeuser@example.com");
    expect(result).not.toContain("+12025551234");
    expect(result).toContain("[REDACTED]");
  });

  /* ------------------------------------------------------------------ */
  /*  PII_USER_FIELDS exports                                            */
  /* ------------------------------------------------------------------ */

  it("exports PII_USER_FIELDS with expected entries", () => {
    expect(PII_USER_FIELDS).toContain("email");
    expect(PII_USER_FIELDS).toContain("phone");
    expect(PII_USER_FIELDS).toContain("firstName");
  });
});

describe("payment PII masking", () => {
  it("masks message text and JSON metadata, including numeric fields", () => {
    const line = JSON.stringify({
      message: "Payment for +254712345123 with national ID=AB123456",
      customer: {
        msisdn: 254712345123,
        nationalId: 12345678,
        bank_account_number: "001234567890",
      },
    });
    expect(JSON.parse(scrubLogOutput(line))).toEqual({
      message: "Payment for +254*****123 with national ID=[REDACTED]",
      customer: {
        msisdn: "+254*****123",
        nationalId: "[REDACTED]",
        bank_account_number: "[REDACTED]",
      },
    });
  });

  it("preserves JSON when the message includes serialized PII", () => {
    const message = JSON.stringify({ bankAccountNumber: "001234567890" });
    const scrubbed = JSON.parse(scrubLogOutput(JSON.stringify({ message })));
    expect(JSON.parse(scrubbed.message)).toEqual({
      bankAccountNumber: "[REDACTED]",
    });
  });
});
