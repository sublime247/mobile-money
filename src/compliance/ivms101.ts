/**
 * IVMS 101 Data Model Serializer — issue #2466
 *
 * Implements the FATF Travel Rule IVMS 101 (interVASP Messaging Standard)
 * data format for cross-border remittances exceeding EUR/USD 1,000 equivalent.
 *
 * Reference: https://intervasp.org/ivms101/
 *
 * The IVMS 101 standard defines three top-level objects:
 *   - Originator   — the sender (customer initiating the transfer)
 *   - Beneficiary  — the recipient
 *   - VASP         — virtual asset service provider identifiers
 *
 * This module:
 *   1. Defines the IVMS 101 TypeScript interfaces
 *   2. Provides buildIVMS101Payload() to construct a valid payload from
 *      TravelRuleParty records already captured by the Travel Rule service
 *   3. Validates mandatory fields and throws descriptive errors on missing data
 */

import type { TravelRuleParty, TravelRuleRecord } from "./travelRule.js";

// ---------------------------------------------------------------------------
// IVMS 101 Type definitions
// ---------------------------------------------------------------------------

/** IVMS 101 §3.1 — Natural person name identifiers */
export interface IVMS101NaturalPersonNameId {
  primaryIdentifier: string;   // last name / full name
  secondaryIdentifier?: string; // first / given name
  nameIdentifierType:
    | "ALIA" // Alias
    | "BIRT" // Name at birth
    | "MAID" // Maiden name
    | "LEGL" // Legal name
    | "MISC";
}

/** IVMS 101 §3.2 — Legal person name identifiers */
export interface IVMS101LegalPersonNameId {
  legalPersonName: string;
  legalPersonNameIdentifierType: "LEGL" | "SHRT" | "TRAD";
}

/** IVMS 101 §3.3 — National identifier */
export interface IVMS101NationalIdentifier {
  nationalIdentifier: string;
  nationalIdentifierType:
    | "ARNU" // Alien registration number
    | "CCPT" // Passport number
    | "RAID" // Registration authority identifier
    | "DRLC" // Driver's licence
    | "FIIN" // Foreign investment identity number
    | "TXID" // Tax identification number
    | "SOCS" // Social security number
    | "IDCD" // Identity card number
    | "LEIX" // Legal entity identifier
    | "MISC";
  countryOfIssue?: string; // ISO 3166-1 alpha-2
}

/** IVMS 101 §3.4 — Geographic address */
export interface IVMS101Address {
  addressType: "GEOG" | "BIZZ" | "HOME";
  streetName?: string;
  buildingNumber?: string;
  buildingName?: string;
  floor?: string;
  postBox?: string;
  room?: string;
  postCode?: string;
  townName?: string;
  countrySubDivision?: string;
  country: string; // ISO 3166-1 alpha-2
}

/** IVMS 101 natural person */
export interface IVMS101NaturalPerson {
  name: { nameIdentifiers: IVMS101NaturalPersonNameId[] };
  geographicAddress?: IVMS101Address[];
  nationalIdentification?: IVMS101NationalIdentifier;
  dateAndPlaceOfBirth?: { dateOfBirth: string; placeOfBirth?: string };
}

/**
 * IVMS 101 Data Builder and Validator
 * Implements FATF Travel Rule standard (InterVASP Messaging Standard 101)
 * Issue #2335
 */

export interface Ivms101NaturalPerson {
  name: {
    primaryIdentifier: string;
    secondaryIdentifier?: string;
    nameIdentifierType?: "LEGL" | "ALIA" | "BIRT";
  };
  geographicAddress?: {
    streetName?: string;
    buildingNumber?: string;
    townName?: string;
    postCode?: string;
    country: string; // ISO-3166-1 alpha-2
    addressType?: "HOME" | "BIZZ" | "GEOG";
  };
  nationalIdentification?: {
    nationalIdentifier: string;
    nationalIdentifierType: "ARNU" | "CCPT" | "RAID" | "DRLC" | "SOCS" | "TXID";
    countryOfIssue: string;
  };
  dateAndPlaceOfBirth?: {
    dateOfBirth: string; // YYYY-MM-DD
    placeOfBirth?: string;
  };
  countryOfResidence?: string;
}

/** IVMS 101 originator/beneficiary account */
export interface IVMS101Person {
  naturalPerson?: IVMS101NaturalPerson;
}

/** IVMS 101 originator block */
export interface IVMS101Originator {
  originatorPersons: IVMS101Person[];
  accountNumber: string[];
}

/** IVMS 101 beneficiary block */
export interface IVMS101Beneficiary {
  beneficiaryPersons: IVMS101Person[];
  accountNumber: string[];
}

/** IVMS 101 VASP identifier */
export interface IVMS101VASP {
  name?: string;
  legalPersonIdentification?: {
    legalPersonName: string;
    legalPersonNameIdentifierType: "LEGL" | "SHRT" | "TRAD";
  };
}

/** Full IVMS 101 payload (top-level Transfer object) */
export interface IVMS101Payload {
  IVMS101Version: "2019-01-21";
  originator: IVMS101Originator;
  beneficiary: IVMS101Beneficiary;
  originatingVASP?: IVMS101VASP;
  beneficiaryVASP?: IVMS101VASP;
  transferPath?: unknown;
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface IVMS101ValidationResult {
  valid: boolean;
  errors: string[];
}

const MANDATORY_ORIGINATOR_FIELDS = ["name", "account"] as const;
const MANDATORY_BENEFICIARY_FIELDS = ["name", "account"] as const;

/**
 * Validate that mandatory IVMS 101 fields are present on both parties.
 *
 * Per FATF Recommendation 16, the following are mandatory for the originator:
 *   - Legal name, account number, (address OR national ID OR date+place of birth)
 *
 * For the beneficiary: legal name and account number are the minimum.
 */
export function validateIVMS101Input(
  sender: TravelRuleParty,
  receiver: TravelRuleParty,
): IVMS101ValidationResult {
  const errors: string[] = [];

  // Originator mandatory fields
  for (const field of MANDATORY_ORIGINATOR_FIELDS) {
    if (!sender[field]) {
      errors.push(`Originator missing mandatory field: ${field}`);
    }
  }

  // At least one of: address, national ID, or date of birth
  if (!sender.address && !sender.idNumber && !sender.dob) {
    errors.push(
      "Originator must provide at least one of: address, national identifier, or date of birth",
    );
  }

  // Beneficiary mandatory fields
  for (const field of MANDATORY_BENEFICIARY_FIELDS) {
    if (!receiver[field]) {
      errors.push(`Beneficiary missing mandatory field: ${field}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Parse a free-text address string into an IVMS 101 Address object.
 * Best-effort: maps the entire string to streetName; country defaults to "ZZ"
 * (unknown) unless the string ends with a 2-letter uppercase code.
 */
function parseAddress(raw: string): IVMS101Address {
  const countryMatch = raw.match(/\b([A-Z]{2})$/);
  const country = countryMatch ? countryMatch[1] : "ZZ";
  return {
    addressType: "GEOG",
    streetName: raw,
    country,
  };
}

/**
 * Split a full name string into primary (last) and secondary (first) identifiers.
 * Handles single-word names by using the entire string as primaryIdentifier.
 */
function splitName(
  fullName: string,
): IVMS101NaturalPersonNameId {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return {
      primaryIdentifier: parts[0],
      nameIdentifierType: "LEGL",
    };
  }
  // Convention: first word(s) = secondary (given), last word = primary (family)
  const primary = parts[parts.length - 1];
  const secondary = parts.slice(0, parts.length - 1).join(" ");
  return {
    primaryIdentifier: primary,
    secondaryIdentifier: secondary,
    nameIdentifierType: "LEGL",
  };
}

/**
 * Build a full IVMS 101 payload from Travel Rule party records.
 *
 * @throws Error if mandatory validation fails and `strict` is true (default).
 */
export function buildIVMS101Payload(
  sender: TravelRuleParty,
  receiver: TravelRuleParty,
  options: {
    originatingVasp?: string;
    beneficiaryVasp?: string;
    /** Throw on validation errors (default: true) */
    strict?: boolean;
  } = {},
): IVMS101Payload {
  const strict = options.strict !== false;

  const validation = validateIVMS101Input(sender, receiver);
  if (!validation.valid && strict) {
    throw new Error(
      `IVMS 101 validation failed: ${validation.errors.join("; ")}`,
    );
  }

  // ── Originator ────────────────────────────────────────────────────────────
  const originatorPerson: IVMS101NaturalPerson = {
    name: { nameIdentifiers: [splitName(sender.name)] },
  };

  if (sender.address) {
    originatorPerson.geographicAddress = [parseAddress(sender.address)];
  }

  if (sender.idNumber) {
    originatorPerson.nationalIdentification = {
      nationalIdentifier: sender.idNumber,
      nationalIdentifierType: "MISC",
    };
  }

  if (sender.dob) {
    originatorPerson.dateAndPlaceOfBirth = { dateOfBirth: sender.dob };
  }

  // ── Beneficiary ───────────────────────────────────────────────────────────
  const beneficiaryPerson: IVMS101NaturalPerson = {
    name: { nameIdentifiers: [splitName(receiver.name)] },
  };

  if (receiver.address) {
    beneficiaryPerson.geographicAddress = [parseAddress(receiver.address)];
  }

  // ── VASP blocks ───────────────────────────────────────────────────────────
  const originatingVASP: IVMS101VASP | undefined = options.originatingVasp
    ? {
        name: options.originatingVasp,
        legalPersonIdentification: {
          legalPersonName: options.originatingVasp,
          legalPersonNameIdentifierType: "LEGL",
        },
      }
    : undefined;

  const beneficiaryVASP: IVMS101VASP | undefined = options.beneficiaryVasp
    ? {
        name: options.beneficiaryVasp,
        legalPersonIdentification: {
          legalPersonName: options.beneficiaryVasp,
          legalPersonNameIdentifierType: "LEGL",
        },
      }
    : undefined;

  return {
    IVMS101Version: "2019-01-21",
    originator: {
      originatorPersons: [{ naturalPerson: originatorPerson }],
      accountNumber: [sender.account],
    },
    beneficiary: {
      beneficiaryPersons: [{ naturalPerson: beneficiaryPerson }],
      accountNumber: [receiver.account],
    },
    ...(originatingVASP && { originatingVASP }),
    ...(beneficiaryVASP && { beneficiaryVASP }),
  };
}

/**
 * Convenience wrapper — build an IVMS 101 payload directly from a
 * TravelRuleRecord (already captured by the Travel Rule service).
 */
export function buildIVMS101FromRecord(
  record: TravelRuleRecord,
  options: { strict?: boolean } = {},
): IVMS101Payload {
  return buildIVMS101Payload(record.sender, record.receiver, {
    originatingVasp: record.originatingVasp,
    beneficiaryVasp: record.beneficiaryVasp,
    strict: options.strict,
  });
}

export interface Ivms101LegalPerson {
  name: {
    legalName: string;
    legalNameIdentifierType?: "LEGL" | "SHRT" | "TRAD";
  };
  geographicAddress?: {
    streetName?: string;
    buildingNumber?: string;
    townName?: string;
    postCode?: string;
    country: string;
  };
  nationalIdentification?: {
    nationalIdentifier: string;
    nationalIdentifierType: "LEIX" | "TXID" | "RAID";
    countryOfIssue: string;
  };
}

export interface Ivms101Payload {
  originator: {
    originatorPersons: Array<{
      naturalPerson?: Ivms101NaturalPerson;
      legalPerson?: Ivms101LegalPerson;
    }>;
    accountNumber?: string[];
  };
  beneficiary: {
    beneficiaryPersons: Array<{
      naturalPerson?: Ivms101NaturalPerson;
      legalPerson?: Ivms101LegalPerson;
    }>;
    accountNumber?: string[];
  };
  originatingVasp?: {
    legalPerson?: Ivms101LegalPerson;
  };
  beneficiaryVasp?: {
    legalPerson?: Ivms101LegalPerson;
  };
}

export interface CreateIvms101Input {
  originatorName: string;
  originatorAccount: string;
  originatorAddress?: {
    street?: string;
    city?: string;
    postCode?: string;
    country: string;
  };
  originatorDob?: string;
  originatorIdNumber?: string;
  beneficiaryName: string;
  beneficiaryAccount: string;
  beneficiaryAddress?: {
    street?: string;
    city?: string;
    postCode?: string;
    country: string;
  };
  originatingVaspName?: string;
  beneficiaryVaspName?: string;
  amount: number;
  currency: string;
}

export const TRAVEL_RULE_THRESHOLD_USD = 1000;

export function isTravelRuleRequired(amount: number): boolean {
  return amount >= TRAVEL_RULE_THRESHOLD_USD;
}

export function validateDateOfBirth(dob: string): boolean {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dob)) return false;
  const date = new Date(dob);
  return !isNaN(date.getTime()) && date < new Date();
}

export function validateCountryCode(country: string): boolean {
  return /^[A-Z]{2}$/.test(country);
}

export function buildIvms101Payload(input: CreateIvms101Input): Ivms101Payload {
  if (input.originatorDob && !validateDateOfBirth(input.originatorDob)) {
    throw new Error(`Invalid date of birth format: ${input.originatorDob}. Expected YYYY-MM-DD.`);
  }

  if (input.originatorAddress?.country && !validateCountryCode(input.originatorAddress.country)) {
    throw new Error(`Invalid country code: ${input.originatorAddress.country}. Expected 2-letter ISO code.`);
  }

  if (input.beneficiaryAddress?.country && !validateCountryCode(input.beneficiaryAddress.country)) {
    throw new Error(`Invalid country code: ${input.beneficiaryAddress.country}. Expected 2-letter ISO code.`);
  }

  const payload: Ivms101Payload = {
    originator: {
      originatorPersons: [
        {
          naturalPerson: {
            name: {
              primaryIdentifier: input.originatorName,
              nameIdentifierType: "LEGL",
            },
            ...(input.originatorAddress && {
              geographicAddress: {
                streetName: input.originatorAddress.street,
                townName: input.originatorAddress.city,
                postCode: input.originatorAddress.postCode,
                country: input.originatorAddress.country,
                addressType: "GEOG",
              },
            }),
            ...(input.originatorIdNumber && {
              nationalIdentification: {
                nationalIdentifier: input.originatorIdNumber,
                nationalIdentifierType: "RAID",
                countryOfIssue: input.originatorAddress?.country || "US",
              },
            }),
            ...(input.originatorDob && {
              dateAndPlaceOfBirth: {
                dateOfBirth: input.originatorDob,
              },
            }),
          },
        },
      ],
      accountNumber: [input.originatorAccount],
    },
    beneficiary: {
      beneficiaryPersons: [
        {
          naturalPerson: {
            name: {
              primaryIdentifier: input.beneficiaryName,
              nameIdentifierType: "LEGL",
            },
            ...(input.beneficiaryAddress && {
              geographicAddress: {
                streetName: input.beneficiaryAddress.street,
                townName: input.beneficiaryAddress.city,
                postCode: input.beneficiaryAddress.postCode,
                country: input.beneficiaryAddress.country,
                addressType: "GEOG",
              },
            }),
          },
        },
      ],
      accountNumber: [input.beneficiaryAccount],
    },
  };

  if (input.originatingVaspName) {
    payload.originatingVasp = {
      legalPerson: {
        name: {
          legalName: input.originatingVaspName,
          legalNameIdentifierType: "LEGL",
        },
      },
    };
  }

  if (input.beneficiaryVaspName) {
    payload.beneficiaryVasp = {
      legalPerson: {
        name: {
          legalName: input.beneficiaryVaspName,
          legalNameIdentifierType: "LEGL",
        },
      },
    };
  }

  return payload;
}
