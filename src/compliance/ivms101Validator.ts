import { z } from "zod";

const countryCode = z
  .string()
  .regex(/^[A-Z]{2}$/, "Expected ISO 3166-1 alpha-2 country code");

const naturalNameIdentifierSchema = z
  .object({
    primaryIdentifier: z.string().trim().min(1),
    secondaryIdentifier: z.string().trim().min(1).optional(),
    nameIdentifierType: z.enum(["ALIA", "BIRT", "MAID", "LEGL", "MISC"]),
  })
  .strict();

const legalNameIdentifierSchema = z
  .object({
    legalPersonName: z.string().trim().min(1),
    legalPersonNameIdentifierType: z.enum(["LEGL", "SHRT", "TRAD"]),
  })
  .strict();

const nationalIdentificationSchema = z
  .object({
    nationalIdentifier: z.string().trim().min(1),
    nationalIdentifierType: z.enum([
      "ARNU",
      "CCPT",
      "RAID",
      "DRLC",
      "FIIN",
      "TXID",
      "SOCS",
      "IDCD",
      "LEIX",
      "MISC",
    ]),
    countryOfIssue: countryCode.optional(),
  })
  .strict();

const geographicAddressSchema = z
  .object({
    addressType: z.enum(["GEOG", "BIZZ", "HOME"]),
    department: z.string().trim().min(1).optional(),
    subDepartment: z.string().trim().min(1).optional(),
    streetName: z.string().trim().min(1).optional(),
    buildingNumber: z.string().trim().min(1).optional(),
    buildingName: z.string().trim().min(1).optional(),
    floor: z.string().trim().min(1).optional(),
    postBox: z.string().trim().min(1).optional(),
    room: z.string().trim().min(1).optional(),
    postCode: z.string().trim().min(1).optional(),
    townName: z.string().trim().min(1).optional(),
    townLocationName: z.string().trim().min(1).optional(),
    districtName: z.string().trim().min(1).optional(),
    countrySubDivision: z.string().trim().min(1).optional(),
    country: countryCode,
  })
  .strict()
  .superRefine((address, context) => {
    const addressFields = [
      "department",
      "subDepartment",
      "streetName",
      "buildingNumber",
      "buildingName",
      "floor",
      "postBox",
      "room",
      "postCode",
      "townName",
      "townLocationName",
      "districtName",
      "countrySubDivision",
    ] as const;
    if (!addressFields.some((field) => address[field] !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["streetName"],
        message: "Provide at least one geographic address detail",
      });
    }
  });

const naturalPersonSchema = z
  .object({
    name: z
      .object({
        nameIdentifiers: z.array(naturalNameIdentifierSchema).min(1),
      })
      .strict(),
    geographicAddress: z.array(geographicAddressSchema).min(1).optional(),
    nationalIdentification: nationalIdentificationSchema.optional(),
    dateAndPlaceOfBirth: z
      .object({
        dateOfBirth: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
          .refine((value) => {
            const [year, month, day] = value.split("-").map(Number);
            const date = new Date(Date.UTC(year, month - 1, day));
            return (
              date.getUTCFullYear() === year &&
              date.getUTCMonth() === month - 1 &&
              date.getUTCDate() === day &&
              date < new Date()
            );
          }, "Expected a valid past date"),
        placeOfBirth: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const legalPersonSchema = z
  .object({
    name: z
      .object({
        nameIdentifiers: z.array(legalNameIdentifierSchema).min(1),
      })
      .strict(),
    geographicAddress: z.array(geographicAddressSchema).min(1).optional(),
    nationalIdentification: nationalIdentificationSchema.optional(),
  })
  .strict();

const personSchema = z
  .object({
    naturalPerson: naturalPersonSchema.optional(),
    legalPerson: legalPersonSchema.optional(),
  })
  .strict()
  .superRefine((person, context) => {
    const hasNaturalPerson = person.naturalPerson !== undefined;
    const hasLegalPerson = person.legalPerson !== undefined;
    if (hasNaturalPerson === hasLegalPerson) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "Specify exactly one of naturalPerson or legalPerson",
      });
    }
  });

const partySchema = (personsKey: "originatorPersons" | "beneficiaryPersons") =>
  z
    .object({
      [personsKey]: z.array(personSchema).min(1),
      accountNumber: z.array(z.string().trim().min(1)).min(1),
    })
    .strict();

const transferPayloadSchema = z
  .object({
    IVMS101Version: z.literal("2019-01-21"),
    originator: partySchema("originatorPersons"),
    beneficiary: partySchema("beneficiaryPersons"),
    originatingVASP: z
      .object({
        name: z.string().trim().min(1).optional(),
        legalPersonIdentification: z
          .object({
            legalPersonName: z.string().trim().min(1),
            legalPersonNameIdentifierType: z.enum(["LEGL", "SHRT", "TRAD"]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    beneficiaryVASP: z
      .object({
        name: z.string().trim().min(1).optional(),
        legalPersonIdentification: z
          .object({
            legalPersonName: z.string().trim().min(1),
            legalPersonNameIdentifierType: z.enum(["LEGL", "SHRT", "TRAD"]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    transferPath: z.unknown().optional(),
    payload: z.unknown().optional(),
  })
  .strict()
  .superRefine((transfer, context) => {
    transfer.originator.originatorPersons.forEach((person, index) => {
      const identity = person.naturalPerson ?? person.legalPerson;
      if (
        identity &&
        !identity.geographicAddress?.length &&
        !identity.nationalIdentification &&
        !("dateAndPlaceOfBirth" in identity && identity.dateAndPlaceOfBirth)
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "originator",
            "originatorPersons",
            index,
            person.naturalPerson ? "naturalPerson" : "legalPerson",
            "nationalIdentification",
          ],
          message:
            "Provide nationalIdentification, geographicAddress, or dateAndPlaceOfBirth",
        });
      }
    });
  });

export type IVMS101ValidatedPayload = z.infer<typeof transferPayloadSchema>;

export interface IVMS101SchemaError {
  path: string;
  message: string;
}

export interface IVMS101SchemaValidationResult {
  valid: boolean;
  errors: IVMS101SchemaError[];
}

function toJsonPointer(path: PropertyKey[]): string {
  return path
    .map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1"))
    .map((part) => `/${part}`)
    .join("");
}

export function validateIVMS101Payload(
  payload: unknown,
): IVMS101SchemaValidationResult {
  const result = transferPayloadSchema.safeParse(payload);
  if (result.success) return { valid: true, errors: [] };

  return {
    valid: false,
    errors: result.error.issues.map((issue) => ({
      path: toJsonPointer(issue.path),
      message: issue.message,
    })),
  };
}

export class IVMS101ValidationError extends Error {
  public readonly errors: IVMS101SchemaError[];

  constructor(errors: IVMS101SchemaError[]) {
    super("IVMS 101 payload validation failed");
    this.name = "IVMS101ValidationError";
    this.errors = errors;
  }
}

export function serializeIVMS101Payload(payload: unknown): string {
  const result = transferPayloadSchema.safeParse(payload);
  if (!result.success) {
    throw new IVMS101ValidationError(
      result.error.issues.map((issue) => ({
        path: toJsonPointer(issue.path),
        message: issue.message,
      })),
    );
  }

  return JSON.stringify(result.data);
}
