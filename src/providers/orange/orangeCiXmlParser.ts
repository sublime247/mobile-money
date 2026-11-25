/**
 * Orange Money Ivory Coast (CI) XML parser and status normalizer.
 *
 * Orange CI sends merchant collection notifications as XML rather than JSON.
 * This module:
 *   - Parses the inbound XML safely (XXE mitigated via fast-xml-parser options).
 *   - Maps Orange CI status codes to internal transaction states.
 *   - Serialises the XML response body expected by the Orange Money gateway.
 */

import { XMLParser, XMLBuilder } from "fast-xml-parser";
import logger from "../../utils/logger";
import { TransactionStatus } from "../../models/transaction";

// ─── XXE-safe XML parser ──────────────────────────────────────────────────────

/**
 * fast-xml-parser does not perform network entity resolution by default
 * (no DTD loading, no external entity expansion), so XXE is not possible.
 * We additionally set `processEntities: false` to suppress internal entity
 * expansion and `allowBooleanAttributes: false` to keep the parsing strict.
 */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: true,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,       // disable entity expansion (XXE guard)
  allowBooleanAttributes: false,
});

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: false,
  suppressEmptyNode: false,
  processEntities: false,
});

// ─── Orange CI status mapping ─────────────────────────────────────────────────

/** Status codes sent by the Orange Money Ivory Coast gateway. */
export type OrangeCiStatus = "SUCCESS" | "REFUSED" | "CANCELLED";

/**
 * Map an Orange CI `status` string to the internal TransactionStatus.
 * Unknown values are treated as Failed to surface them for investigation.
 */
export function mapOrangeCiStatus(raw: string): TransactionStatus {
  const upper = String(raw ?? "").toUpperCase().trim();
  switch (upper as OrangeCiStatus) {
    case "SUCCESS":
      return TransactionStatus.Completed;
    case "REFUSED":
      return TransactionStatus.Failed;
    case "CANCELLED":
      return TransactionStatus.Cancelled;
    default:
      logger.warn(
        { orangeCiStatus: raw },
        "[orange-ci-xml] Unknown Orange CI status code; mapping to Failed",
      );
      return TransactionStatus.Failed;
  }
}

// ─── Inbound payload types ────────────────────────────────────────────────────

export interface OrangeCiNotification {
  /** Orange Money transaction reference */
  transactionId: string;
  /** Client/merchant reference supplied at payment initiation */
  clientReference: string;
  /** Raw Orange CI status string */
  rawStatus: OrangeCiStatus | string;
  /** Mapped internal status */
  status: TransactionStatus;
  /** Amount in minor currency units */
  amount?: string;
  /** Currency code */
  currency?: string;
  /** Subscriber MSISDN */
  msisdn?: string;
  /** Additional free-text message from the gateway */
  message?: string;
}

// ─── XML parse result ─────────────────────────────────────────────────────────

export interface ParseResult<T> {
  success: true;
  data: T;
}

export interface ParseFailure {
  success: false;
  error: string;
}

export type OrangeCiParseResult =
  | ParseResult<OrangeCiNotification>
  | ParseFailure;

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse an Orange CI merchant notification XML body.
 *
 * Expected envelope (field names may vary; we accept both `transactionId`
 * and `transaction_id` / `txnId` patterns for resilience):
 *
 * ```xml
 * <OrangeMoneyNotification>
 *   <transactionId>TXN123</transactionId>
 *   <clientReference>REF456</clientReference>
 *   <status>SUCCESS</status>
 *   <amount>5000</amount>
 *   <currency>XOF</currency>
 *   <msisdn>2250700000000</msisdn>
 *   <message>Payment received</message>
 * </OrangeMoneyNotification>
 * ```
 */
export function parseOrangeCiXml(xmlBody: string): OrangeCiParseResult {
  if (!xmlBody || typeof xmlBody !== "string" || xmlBody.trim().length === 0) {
    return { success: false, error: "Empty XML body" };
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = xmlParser.parse(xmlBody) as Record<string, unknown>;
  } catch (err) {
    return {
      success: false,
      error: `XML parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The root element name can vary; we look inside the first key.
  const root =
    (parsed["OrangeMoneyNotification"] as Record<string, unknown>) ??
    (parsed["notification"] as Record<string, unknown>) ??
    (parsed["Notification"] as Record<string, unknown>);

  if (!root || typeof root !== "object") {
    return { success: false, error: "Missing or unrecognised root XML element" };
  }

  // Accept common field-name variations.
  const transactionId = String(
    root["transactionId"] ??
      root["transaction_id"] ??
      root["txnId"] ??
      root["txn_id"] ??
      "",
  ).trim();

  const clientReference = String(
    root["clientReference"] ??
      root["client_reference"] ??
      root["reference"] ??
      "",
  ).trim();

  const rawStatus = String(
    root["status"] ?? root["Status"] ?? "",
  ).trim();

  if (!transactionId) {
    return { success: false, error: "Missing transactionId in XML payload" };
  }
  if (!clientReference) {
    return { success: false, error: "Missing clientReference in XML payload" };
  }
  if (!rawStatus) {
    return { success: false, error: "Missing status in XML payload" };
  }

  const notification: OrangeCiNotification = {
    transactionId,
    clientReference,
    rawStatus,
    status: mapOrangeCiStatus(rawStatus),
    amount: root["amount"] !== undefined ? String(root["amount"]).trim() : undefined,
    currency: root["currency"] !== undefined ? String(root["currency"]).trim() : undefined,
    msisdn: root["msisdn"] !== undefined ? String(root["msisdn"]).trim() : undefined,
    message: root["message"] !== undefined ? String(root["message"]).trim() : undefined,
  };

  return { success: true, data: notification };
}

// ─── Response builder ─────────────────────────────────────────────────────────

export interface OrangeCiAck {
  code: string;
  message: string;
}

/**
 * Build the XML acknowledgement payload expected by the Orange Money CI
 * gateway.  Orange Money expects a 200 response with this body to stop
 * retrying a notification.
 */
export function buildOrangeCiAckXml(ack: OrangeCiAck): string {
  const obj = {
    OrangeMoneyAck: {
      code: ack.code,
      message: ack.message,
    },
  };
  return xmlBuilder.build(obj) as string;
}

/** Standard ack for a successfully processed notification. */
export const ORANGE_CI_ACK_OK: OrangeCiAck = {
  code: "00",
  message: "Accepted",
};

/** Ack returned when our processing fails (gateway may retry). */
export const ORANGE_CI_ACK_ERROR: OrangeCiAck = {
  code: "99",
  message: "Internal error",
};
