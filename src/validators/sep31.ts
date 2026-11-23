import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import logger from "../utils/logger";

/**
 * ISO 3166-1 country required KYC attributes mapping (#1945)
 */
export interface CountryKycRequirement {
  senderRequired: string[];
  receiverRequired: string[];
}

export const COUNTRY_KYC_REQUIREMENTS: Record<string, CountryKycRequirement> = {
  DEFAULT: {
    senderRequired: ["first_name", "last_name", "id_number"],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
  USA: {
    senderRequired: [
      "first_name",
      "last_name",
      "id_number",
      "address",
      "city",
      "state_or_province",
      "postal_code",
    ],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
  US: {
    senderRequired: [
      "first_name",
      "last_name",
      "id_number",
      "address",
      "city",
      "state_or_province",
      "postal_code",
    ],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
  NGA: {
    senderRequired: ["first_name", "last_name", "id_number", "mobile_number"],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
  NG: {
    senderRequired: ["first_name", "last_name", "id_number", "mobile_number"],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
  GBR: {
    senderRequired: [
      "first_name",
      "last_name",
      "id_number",
      "address",
      "postal_code",
    ],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
  GB: {
    senderRequired: [
      "first_name",
      "last_name",
      "id_number",
      "address",
      "postal_code",
    ],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
  DEU: {
    senderRequired: ["first_name", "last_name", "id_number", "address"],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
  FRA: {
    senderRequired: ["first_name", "last_name", "id_number", "address"],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
  SEN: {
    senderRequired: ["first_name", "last_name", "id_number", "mobile_number"],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
  CIV: {
    senderRequired: ["first_name", "last_name", "id_number", "mobile_number"],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
};

export function getKycRequirementsForCountry(
  countryCode?: string,
): CountryKycRequirement {
  if (!countryCode) return COUNTRY_KYC_REQUIREMENTS.DEFAULT;
  const normalized = countryCode.toUpperCase().trim();
  return (
    COUNTRY_KYC_REQUIREMENTS[normalized] || COUNTRY_KYC_REQUIREMENTS.DEFAULT
  );
}

export const sep31KycFieldsSchema = z
  .object({
    sender: z.record(z.string(), z.any()).optional(),
    receiver: z.record(z.string(), z.any()).optional(),
    transaction: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

export interface ValidateSep31KycResult {
  valid: boolean;
  missingSenderFields: string[];
  missingReceiverFields: string[];
  error?: string;
}

/**
 * Strict validation of sender and receiver KYC fields against country specifications (#1945).
 */
export function validateSep31KycFields(
  fields: Record<string, any> = {},
  senderId?: string,
  receiverId?: string,
  countryCode?: string,
): ValidateSep31KycResult {
  const senderFields = fields.sender || fields.sender_fields || {};
  const receiverFields = fields.receiver || fields.receiver_fields || {};
  const requirements = getKycRequirementsForCountry(
    countryCode || fields.country_code,
  );

  const missingSenderFields: string[] = [];
  for (const reqField of requirements.senderRequired) {
    const val = senderFields[reqField] ?? fields[`sender_${reqField}`];
    if (val === undefined || val === null || String(val).trim() === "") {
      missingSenderFields.push(reqField);
    }
  }

  const missingReceiverFields: string[] = [];
  for (const reqField of requirements.receiverRequired) {
    const val = receiverFields[reqField] ?? fields[`receiver_${reqField}`];
    if (val === undefined || val === null || String(val).trim() === "") {
      missingReceiverFields.push(reqField);
    }
  }

  const valid =
    missingSenderFields.length === 0 && missingReceiverFields.length === 0;

  if (valid) {
    logger.info(
      {
        event: "sep31_kyc_compliance_validated",
        senderId,
        receiverId,
        countryCode: countryCode || fields.country_code || "DEFAULT",
      },
      "SEP-31 KYC compliance validated successfully",
    );
  } else {
    logger.warn(
      {
        event: "sep31_kyc_validation_failed",
        senderId,
        receiverId,
        missingSenderFields,
        missingReceiverFields,
      },
      "SEP-31 KYC validation failed: missing mandatory compliance fields",
    );
  }

  const errors: string[] = [];
  if (missingSenderFields.length > 0) {
    errors.push(
      `Missing mandatory sender KYC fields: ${missingSenderFields.join(", ")}`,
    );
  }
  if (missingReceiverFields.length > 0) {
    errors.push(
      `Missing mandatory receiver KYC fields: ${missingReceiverFields.join(", ")}`,
    );
  }

  return {
    valid,
    missingSenderFields,
    missingReceiverFields,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

/**
 * Maps the ISO 3166-1 alpha-3 codes already used as keys in
 * COUNTRY_KYC_REQUIREMENTS to their alpha-2 equivalent, since
 * libphonenumber-js's parsed `country` is always alpha-2. Limited to the
 * codes this module already recognizes rather than a full ISO-3166 table,
 * to stay in sync with COUNTRY_KYC_REQUIREMENTS instead of introducing a
 * second, independently-maintained country code source.
 */
const ALPHA3_TO_ALPHA2: Record<string, string> = {
  USA: "US",
  NGA: "NG",
  GBR: "GB",
  DEU: "DE",
  FRA: "FR",
  SEN: "SN",
  CIV: "CI",
};

function toAlpha2(countryCode: string): string {
  const normalized = countryCode.toUpperCase().trim();
  if (normalized.length === 2) return normalized;
  return ALPHA3_TO_ALPHA2[normalized] || normalized;
}

export interface ValidateReceiverPhoneCountryResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates that the receiver's mobile_number is a valid E.164 phone number
 * whose country matches the transfer's destination country code (#2263).
 *
 * This guards against a receiver phone number that does not correspond to
 * the declared destination corridor, e.g. a US phone number for a transfer
 * whose destination_country is Nigeria — a mismatch that usually signals a
 * misrouted or malformed cross-border request.
 *
 * Returns valid: true when no destination country code is supplied at all
 * (the existing SEP-9 field schema already validates E.164 format
 * independently; this check only adds the country-match constraint when a
 * destination country is actually declared).
 */
export function validateReceiverPhoneCountryMatch(
  receiverMobileNumber: string | undefined,
  destinationCountryCode: string | undefined,
): ValidateReceiverPhoneCountryResult {
  if (!destinationCountryCode) return { valid: true };
  if (!receiverMobileNumber) return { valid: true };

  const parsed = parsePhoneNumberFromString(receiverMobileNumber);
  if (!parsed || !parsed.isValid() || !parsed.country) {
    return {
      valid: false,
      error: `Receiver mobile_number is not a valid E.164 phone number for destination country ${destinationCountryCode}`,
    };
  }

  const expectedAlpha2 = toAlpha2(destinationCountryCode);
  if (parsed.country !== expectedAlpha2) {
    return {
      valid: false,
      error: `Receiver mobile_number country code (${parsed.country}) does not match destination country (${destinationCountryCode})`,
    };
  }

  return { valid: true };
}

export interface ValidateSenderKycApprovedResult {
  valid: boolean;
  error?: string;
}

/**
 * SEP-12 customer-status lookup for a SEP-31 sender (#2263).
 *
 * Reuses UserModel.findById (the same user record SEP-12 identity checks
 * elsewhere in this codebase key off) rather than introducing a second KYC
 * status source. A user whose kycLevel is "none"/"unverified" (the
 * KYCLevel.NONE/UNVERIFIED value in services/kyc.ts) has not reached an
 * approved SEP-12 status and is rejected; "basic" and "full" are both
 * treated as approved, matching how services/kyc.ts#getTransactionLimits
 * already treats any non-UNVERIFIED level as KYC-cleared for transacting.
 *
 * `findUserById` is injected so callers (and tests) are not forced to wire
 * a live Postgres pool just to exercise this check.
 */
export async function validateSenderKycApproved(
  senderId: string,
  findUserById: (id: string) => Promise<{ kycLevel?: string } | null>,
): Promise<ValidateSenderKycApprovedResult> {
  if (!senderId) {
    return {
      valid: false,
      error: "Missing sender_id for SEP-12 KYC status lookup",
    };
  }

  let user: { kycLevel?: string } | null;
  try {
    user = await findUserById(senderId);
  } catch (err) {
    logger.error(
      { err, senderId },
      "[SEP-31] Failed to look up sender SEP-12 KYC status",
    );
    return {
      valid: false,
      error: "Unable to verify sender KYC status; please retry",
    };
  }

  if (!user) {
    return {
      valid: false,
      error: `No SEP-12 customer record found for sender_id ${senderId}`,
    };
  }

  const kycLevel = (user.kycLevel || "none").toLowerCase();
  const isApproved = kycLevel === "basic" || kycLevel === "full";

  if (!isApproved) {
    return {
      valid: false,
      error: `Sender SEP-12 KYC status is not approved (kyc_level: ${kycLevel})`,
    };
  }

  return { valid: true };
}
