/**
 * SAR XML Export Service — issue #2469
 *
 * Generates FinCEN-compliant Suspicious Activity Report (SAR) XML files
 * conforming to the FinCEN BSA XML 2.0 schema (simplified representation
 * matching the structural requirements for electronic filing).
 *
 * Key fields per FinCEN SAR filing:
 *   - Filing institution details
 *   - Subject information (sender / account holder)
 *   - Suspicious activity type, dates, and narrative
 *   - Transaction hashes, amounts, and IP logs
 *
 * The generated XML is validated against the expected structure before
 * the buffer is returned.
 *
 * References:
 *   https://bsaefiling.fincen.treas.gov/main.html
 *   FinCEN SAR XML 2.0 schema specification
 */

import { create } from "xmlbuilder2";
import { Transaction } from "../models/transaction.js";
import { AMLAlert } from "./aml.js";
import logger from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SARSubject {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  phoneNumber?: string;
  stellarAddress?: string;
  ipAddress?: string;
  dob?: string;
}

export interface SARFilingOptions {
  /** ISO-8601 date of the suspicious activity */
  activityDate?: string;
  /** Free-text narrative description — max 10 000 chars per FinCEN spec */
  narrative?: string;
  subject?: SARSubject;
  /** Filing institution details */
  institution?: {
    name?: string;
    tin?: string;
    address?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
  };
}

export interface SARExportResult {
  /** Raw UTF-8 XML string */
  xml: string;
  /** Unique FinCEN filing reference composed of alertId + timestamp */
  filingReference: string;
  /** Whether the generated XML passed structural validation */
  valid: boolean;
  validationErrors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FINCEN_SAR_VERSION = "2.0";
const FINCEN_NAMESPACE = "http://www.fincen.gov/base";
const MAX_NARRATIVE_LENGTH = 10_000;

// Required top-level elements for a minimal valid SAR (structural check)
const REQUIRED_ELEMENTS = [
  "EFilingBatchXML",
  "EFilingActivityXML",
  "ActivityType",
  "FilingInstitution",
  "SuspiciousActivity",
] as const;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a FinCEN SAR XML document from a flagged transaction and AML alert.
 *
 * @param transaction   The flagged transaction record
 * @param alert         The AML alert that triggered the SAR
 * @param options       Additional filing metadata (subject info, narrative, etc.)
 * @returns `SARExportResult` containing the XML string and validation status
 */
export function buildSARXml(
  transaction: Transaction,
  alert: AMLAlert,
  options: SARFilingOptions = {},
): SARExportResult {
  const filingReference = `SAR-${alert.id}-${Date.now()}`;
  const activityDate =
    options.activityDate ?? new Date(alert.createdAt).toISOString().slice(0, 10);
  const institution = options.institution ?? {};
  const subject = options.subject ?? {};

  const narrative = truncateNarrative(
    options.narrative ??
      buildDefaultNarrative(transaction, alert),
  );

  // ── XML document ────────────────────────────────────────────────────────
  const root = create({ version: "1.0", encoding: "UTF-8" })
    .ele("EFilingBatchXML", {
      xmlns: FINCEN_NAMESPACE,
      "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "xsi:schemaLocation": `${FINCEN_NAMESPACE} FinCEN_SAR_v${FINCEN_SAR_VERSION}.xsd`,
      "batchVersion": FINCEN_SAR_VERSION,
    });

  // ── Batch header ────────────────────────────────────────────────────────
  const header = root.ele("EFilingBatchHeader");
  header.ele("SubmissionTypeCode").txt("I"); // Initial filing
  header.ele("FilingCreationDateText").txt(new Date().toISOString().slice(0, 10));
  header.ele("FilingReferenceNumber").txt(filingReference);

  // ── Activity ────────────────────────────────────────────────────────────
  const activity = root.ele("EFilingActivityXML");
  activity.ele("ActivityType").txt("SAR"); // Suspicious Activity Report

  // ── Filing institution ───────────────────────────────────────────────────
  const fi = activity.ele("FilingInstitution");
  fi.ele("InstitutionName").txt(
    institution.name ?? process.env.SAR_INSTITUTION_NAME ?? "Mobile Money Platform",
  );
  if (institution.tin) fi.ele("InstitutionTIN").txt(institution.tin);
  if (institution.address) fi.ele("InstitutionAddress").txt(institution.address);
  if (institution.city) fi.ele("InstitutionCity").txt(institution.city);
  if (institution.state) fi.ele("InstitutionState").txt(institution.state);
  if (institution.zipCode) fi.ele("InstitutionZIPCode").txt(institution.zipCode);
  fi.ele("InstitutionCountry").txt(institution.country ?? "US");

  // ── Suspicious activity ─────────────────────────────────────────────────
  const sa = activity.ele("SuspiciousActivity");
  sa.ele("ActivityDateText").txt(activityDate);
  sa.ele("SARFilingReference").txt(filingReference);

  // Alert metadata
  const alertEl = sa.ele("AlertMetadata");
  alertEl.ele("AlertID").txt(alert.id);
  alertEl.ele("AlertSeverity").txt(alert.severity);
  alertEl.ele("AlertStatus").txt(alert.status);
  alertEl.ele("AlertCreatedAt").txt(alert.createdAt);
  alertEl
    .ele("TriggerRules")
    .txt(alert.ruleHits.map((h) => h.rule).join(", "));

  // Transaction details
  const txEl = sa.ele("TransactionInformation");
  txEl.ele("TransactionID").txt(transaction.id);
  txEl.ele("TransactionReferenceNumber").txt(transaction.referenceNumber);
  txEl.ele("TransactionType").txt(transaction.type);
  txEl.ele("TransactionAmount").txt(String(transaction.amount));
  txEl.ele("TransactionCurrency").txt(
    typeof transaction.currency === "string"
      ? transaction.currency.toUpperCase()
      : "USD",
  );
  txEl.ele("TransactionDate").txt(
    new Date(transaction.createdAt).toISOString(),
  );
  txEl.ele("TransactionStatus").txt(transaction.status);
  txEl.ele("ProviderName").txt(transaction.provider ?? "");
  if (transaction.stellarAddress) {
    txEl.ele("StellarTransactionHash").txt(transaction.stellarAddress);
  }

  // Subject information
  const subjectEl = sa.ele("SubjectInformation");
  subjectEl.ele("SubjectID").txt(transaction.userId ?? "UNKNOWN");
  if (subject.firstName || subject.lastName) {
    subjectEl
      .ele("SubjectName")
      .txt(`${subject.firstName ?? ""} ${subject.lastName ?? ""}`.trim());
  } else if (subject.displayName) {
    subjectEl.ele("SubjectName").txt(subject.displayName);
  }
  if (transaction.phoneNumber || subject.phoneNumber) {
    subjectEl
      .ele("SubjectPhoneNumber")
      .txt(subject.phoneNumber ?? transaction.phoneNumber ?? "");
  }
  if (subject.stellarAddress ?? transaction.stellarAddress) {
    subjectEl
      .ele("SubjectStellarAddress")
      .txt(subject.stellarAddress ?? transaction.stellarAddress ?? "");
  }
  if (subject.ipAddress) {
    subjectEl.ele("SubjectIPAddress").txt(subject.ipAddress);
  }
  if (subject.dob) {
    subjectEl.ele("SubjectDateOfBirth").txt(subject.dob);
  }

  // Narrative
  sa.ele("NarrativeText").txt(narrative);

  // Reasons / rule hits
  const reasonsEl = sa.ele("SuspiciousActivityReasons");
  for (const reason of alert.reasons) {
    reasonsEl.ele("Reason").txt(reason);
  }

  const xml = root.end({ prettyPrint: true });

  // ── Structural validation ────────────────────────────────────────────────
  const { valid, errors } = validateSARXml(xml);

  if (!valid) {
    logger.warn(
      { filingReference, errors },
      "[sarExport] Generated SAR XML failed structural validation",
    );
  }

  return { xml, filingReference, valid, validationErrors: errors };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Structural validation — checks that all required SAR elements are present
 * in the generated XML string.
 *
 * Full XSD schema validation would require an external library (libxmljs or
 * similar) which is unavailable in this environment.  This guard catches
 * obvious structural regressions.
 */
export function validateSARXml(xml: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  for (const el of REQUIRED_ELEMENTS) {
    if (!xml.includes(`<${el}`) && !xml.includes(`<${el} `)) {
      errors.push(`Missing required element: <${el}>`);
    }
  }

  // Check encoding declaration
  if (!xml.startsWith("<?xml")) {
    errors.push("Missing XML declaration");
  }

  // Check namespace
  if (!xml.includes(FINCEN_NAMESPACE)) {
    errors.push(`Missing FinCEN namespace: ${FINCEN_NAMESPACE}`);
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateNarrative(text: string): string {
  if (text.length <= MAX_NARRATIVE_LENGTH) return text;
  return text.slice(0, MAX_NARRATIVE_LENGTH - 3) + "...";
}

function buildDefaultNarrative(
  transaction: Transaction,
  alert: AMLAlert,
): string {
  const lines = [
    `Suspicious activity detected for transaction ${transaction.id} ` +
      `(reference: ${transaction.referenceNumber}).`,
    `Transaction type: ${transaction.type}, ` +
      `amount: ${transaction.amount}, provider: ${transaction.provider}.`,
    `AML alert ID: ${alert.id}, severity: ${alert.severity}.`,
    `Triggered rules: ${alert.ruleHits.map((h) => h.rule).join(", ")}.`,
    `Reasons: ${alert.reasons.join("; ")}.`,
    `Review status: ${alert.status}.`,
  ];

  return lines.join(" ");
}
