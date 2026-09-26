import { z } from "zod";
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
    senderRequired: ["first_name", "last_name", "id_number", "address", "city", "state_or_province", "postal_code"],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
  US: {
    senderRequired: ["first_name", "last_name", "id_number", "address", "city", "state_or_province", "postal_code"],
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
    senderRequired: ["first_name", "last_name", "id_number", "address", "postal_code"],
    receiverRequired: ["first_name", "last_name", "mobile_number"],
  },
  GB: {
    senderRequired: ["first_name", "last_name", "id_number", "address", "postal_code"],
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

export function getKycRequirementsForCountry(countryCode?: string): CountryKycRequirement {
  if (!countryCode) return COUNTRY_KYC_REQUIREMENTS.DEFAULT;
  const normalized = countryCode.toUpperCase().trim();
  return COUNTRY_KYC_REQUIREMENTS[normalized] || COUNTRY_KYC_REQUIREMENTS.DEFAULT;
}

export const sep31KycFieldsSchema = z.object({
  sender: z.record(z.any()).optional(),
  receiver: z.record(z.any()).optional(),
  transaction: z.record(z.any()).optional(),
}).passthrough();

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
  const requirements = getKycRequirementsForCountry(countryCode || fields.country_code);

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

  const valid = missingSenderFields.length === 0 && missingReceiverFields.length === 0;

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
    errors.push(`Missing mandatory sender KYC fields: ${missingSenderFields.join(", ")}`);
  }
  if (missingReceiverFields.length > 0) {
    errors.push(`Missing mandatory receiver KYC fields: ${missingReceiverFields.join(", ")}`);
  }

  return {
    valid,
    missingSenderFields,
    missingReceiverFields,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}
