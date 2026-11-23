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
