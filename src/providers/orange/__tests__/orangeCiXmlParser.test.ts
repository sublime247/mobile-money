/**
 * Unit tests for the Orange Money Ivory Coast XML parser and status normalizer.
 *
 * Tests:
 *  - Successful parse of a SUCCESS notification
 *  - Parse of REFUSED and CANCELLED notifications
 *  - Mapping of unknown status codes
 *  - Malformed XML input
 *  - Missing required fields
 *  - XXE payload is not executed (structural check)
 *  - Ack XML builder produces valid output
 */

import { TransactionStatus } from "../../../models/transaction";
import {
  parseOrangeCiXml,
  mapOrangeCiStatus,
  buildOrangeCiAckXml,
  ORANGE_CI_ACK_OK,
  ORANGE_CI_ACK_ERROR,
} from "../orangeCiXmlParser";

// ─── mapOrangeCiStatus ────────────────────────────────────────────────────────

describe("mapOrangeCiStatus", () => {
  it("maps SUCCESS to Completed", () => {
    expect(mapOrangeCiStatus("SUCCESS")).toBe(TransactionStatus.Completed);
  });

  it("maps REFUSED to Failed", () => {
    expect(mapOrangeCiStatus("REFUSED")).toBe(TransactionStatus.Failed);
  });

  it("maps CANCELLED to Cancelled", () => {
    expect(mapOrangeCiStatus("CANCELLED")).toBe(TransactionStatus.Cancelled);
  });

  it("maps an unknown status to Failed", () => {
    expect(mapOrangeCiStatus("UNKNOWN_CODE")).toBe(TransactionStatus.Failed);
  });

  it("is case-insensitive", () => {
    expect(mapOrangeCiStatus("success")).toBe(TransactionStatus.Completed);
    expect(mapOrangeCiStatus("refused")).toBe(TransactionStatus.Failed);
  });
});

// ─── parseOrangeCiXml — success cases ────────────────────────────────────────

describe("parseOrangeCiXml — success", () => {
  it("parses a well-formed SUCCESS notification", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OrangeMoneyNotification>
  <transactionId>TXN001</transactionId>
  <clientReference>REF001</clientReference>
  <status>SUCCESS</status>
  <amount>50000</amount>
  <currency>XOF</currency>
  <msisdn>2250700000001</msisdn>
  <message>Payment received</message>
</OrangeMoneyNotification>`;

    const result = parseOrangeCiXml(xml);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.transactionId).toBe("TXN001");
    expect(result.data.clientReference).toBe("REF001");
    expect(result.data.rawStatus).toBe("SUCCESS");
    expect(result.data.status).toBe(TransactionStatus.Completed);
    expect(result.data.amount).toBe("50000");
    expect(result.data.currency).toBe("XOF");
    expect(result.data.msisdn).toBe("2250700000001");
    expect(result.data.message).toBe("Payment received");
  });

  it("parses a REFUSED notification", () => {
    const xml = `<OrangeMoneyNotification>
  <transactionId>TXN002</transactionId>
  <clientReference>REF002</clientReference>
  <status>REFUSED</status>
</OrangeMoneyNotification>`;

    const result = parseOrangeCiXml(xml);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe(TransactionStatus.Failed);
  });

  it("parses a CANCELLED notification", () => {
    const xml = `<OrangeMoneyNotification>
  <transactionId>TXN003</transactionId>
  <clientReference>REF003</clientReference>
  <status>CANCELLED</status>
</OrangeMoneyNotification>`;

    const result = parseOrangeCiXml(xml);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe(TransactionStatus.Cancelled);
  });

  it("accepts the snake_case field-name variant", () => {
    const xml = `<OrangeMoneyNotification>
  <transaction_id>TXN004</transaction_id>
  <client_reference>REF004</client_reference>
  <status>SUCCESS</status>
</OrangeMoneyNotification>`;

    const result = parseOrangeCiXml(xml);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.transactionId).toBe("TXN004");
    expect(result.data.clientReference).toBe("REF004");
  });

  it("accepts optional fields as undefined when absent", () => {
    const xml = `<OrangeMoneyNotification>
  <transactionId>TXN005</transactionId>
  <clientReference>REF005</clientReference>
  <status>SUCCESS</status>
</OrangeMoneyNotification>`;

    const result = parseOrangeCiXml(xml);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.amount).toBeUndefined();
    expect(result.data.currency).toBeUndefined();
    expect(result.data.msisdn).toBeUndefined();
  });
});

// ─── parseOrangeCiXml — failure cases ────────────────────────────────────────

describe("parseOrangeCiXml — failure", () => {
  it("returns failure for an empty string", () => {
    const result = parseOrangeCiXml("");
    expect(result.success).toBe(false);
  });

  it("returns failure for malformed XML", () => {
    const result = parseOrangeCiXml("<OrangeMoneyNotification><unclosed>");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/XML parse error|Missing/i);
  });

  it("returns failure when transactionId is missing", () => {
    const xml = `<OrangeMoneyNotification>
  <clientReference>REF006</clientReference>
  <status>SUCCESS</status>
</OrangeMoneyNotification>`;
    const result = parseOrangeCiXml(xml);
    expect(result.success).toBe(false);
  });

  it("returns failure when clientReference is missing", () => {
    const xml = `<OrangeMoneyNotification>
  <transactionId>TXN007</transactionId>
  <status>SUCCESS</status>
</OrangeMoneyNotification>`;
    const result = parseOrangeCiXml(xml);
    expect(result.success).toBe(false);
  });

  it("returns failure when status is missing", () => {
    const xml = `<OrangeMoneyNotification>
  <transactionId>TXN008</transactionId>
  <clientReference>REF008</clientReference>
</OrangeMoneyNotification>`;
    const result = parseOrangeCiXml(xml);
    expect(result.success).toBe(false);
  });

  it("returns failure when the root element is unrecognised", () => {
    const xml = `<UnknownRoot><transactionId>T1</transactionId></UnknownRoot>`;
    const result = parseOrangeCiXml(xml);
    expect(result.success).toBe(false);
  });
});

// ─── XXE guard (structural) ───────────────────────────────────────────────────

describe("XXE protection", () => {
  it("does not expand external entity references — the value remains literal", () => {
    // A real XXE attack would replace &xxe; with file contents.
    // With entity processing disabled the entity reference is left unexpanded
    // or stripped, never resolved to file content.
    const xxePayload = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<OrangeMoneyNotification>
  <transactionId>&xxe;</transactionId>
  <clientReference>REF_XXE</clientReference>
  <status>SUCCESS</status>
</OrangeMoneyNotification>`;

    const result = parseOrangeCiXml(xxePayload);
    // The parser should either fail to parse or return the literal entity
    // string — it must not return any file contents.
    if (result.success) {
      // Entity was not expanded — the transactionId does not contain /etc/passwd content.
      expect(result.data.transactionId).not.toMatch(/root:|nobody:/);
    } else {
      // Parser rejected the input — also acceptable.
      expect(result.success).toBe(false);
    }
  });
});

// ─── buildOrangeCiAckXml ──────────────────────────────────────────────────────

describe("buildOrangeCiAckXml", () => {
  it("produces XML containing the ack code and message", () => {
    const xml = buildOrangeCiAckXml(ORANGE_CI_ACK_OK);
    expect(xml).toContain("<code>00</code>");
    expect(xml).toContain("<message>Accepted</message>");
  });

  it("produces an error ack with code 99", () => {
    const xml = buildOrangeCiAckXml(ORANGE_CI_ACK_ERROR);
    expect(xml).toContain("<code>99</code>");
    expect(xml).toContain("<message>Internal error</message>");
  });

  it("wraps the ack in the OrangeMoneyAck root element", () => {
    const xml = buildOrangeCiAckXml(ORANGE_CI_ACK_OK);
    expect(xml).toContain("<OrangeMoneyAck>");
    expect(xml).toContain("</OrangeMoneyAck>");
  });
});
