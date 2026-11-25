import {
  serializeIVMS101Payload,
  validateIVMS101Payload,
} from "../ivms101Validator";

describe("IVMS 101 payload validation and serialization", () => {
  const validPayload = {
    IVMS101Version: "2019-01-21",
    originator: {
      originatorPersons: [
        {
          naturalPerson: {
            name: {
              nameIdentifiers: [
                {
                  primaryIdentifier: "Smith",
                  secondaryIdentifier: "Alice",
                  nameIdentifierType: "LEGL",
                },
              ],
            },
            geographicAddress: [
              {
                addressType: "HOME",
                streetName: "1 Main Street",
                townName: "London",
                postCode: "SW1A 1AA",
                country: "GB",
              },
            ],
            nationalIdentification: {
              nationalIdentifier: "ID-12345",
              nationalIdentifierType: "CCPT",
              countryOfIssue: "GB",
            },
            dateAndPlaceOfBirth: {
              dateOfBirth: "1985-06-15",
              placeOfBirth: "London",
            },
          },
        },
      ],
      accountNumber: ["originator-account"],
    },
    beneficiary: {
      beneficiaryPersons: [
        {
          legalPerson: {
            name: {
              nameIdentifiers: [
                {
                  legalPersonName: "Example Beneficiary Ltd",
                  legalPersonNameIdentifierType: "LEGL",
                },
              ],
            },
            geographicAddress: [
              {
                addressType: "BIZZ",
                buildingNumber: "10",
                streetName: "Market Road",
                townName: "Nairobi",
                country: "KE",
              },
            ],
            nationalIdentification: {
              nationalIdentifier: "LEI-123",
              nationalIdentifierType: "LEIX",
              countryOfIssue: "KE",
            },
          },
        },
      ],
      accountNumber: ["beneficiary-account"],
    },
  };

  it("validates and serializes natural and legal person data", () => {
    expect(validateIVMS101Payload(validPayload)).toEqual({
      valid: true,
      errors: [],
    });

    expect(JSON.parse(serializeIVMS101Payload(validPayload))).toEqual(
      validPayload,
    );
  });

  it("reports the JSON pointer when originator identity evidence is missing", () => {
    const invalidPayload = {
      ...validPayload,
      originator: {
        ...validPayload.originator,
        originatorPersons: [
          {
            naturalPerson: {
              name: validPayload.originator.originatorPersons[0].naturalPerson
                .name,
            },
          },
        ],
      },
    };

    const result = validateIVMS101Payload(invalidPayload);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      path: "/originator/originatorPersons/0/naturalPerson/nationalIdentification",
      message:
        "Provide nationalIdentification, geographicAddress, or dateAndPlaceOfBirth",
    });
  });

  it("rejects malformed geographic address country codes and empty addresses", () => {
    const invalidPayload = {
      ...validPayload,
      beneficiary: {
        ...validPayload.beneficiary,
        beneficiaryPersons: [
          {
            legalPerson: {
              ...validPayload.beneficiary.beneficiaryPersons[0].legalPerson,
              geographicAddress: [
                {
                  addressType: "HOME",
                  country: "usa",
                },
              ],
            },
          },
        ],
      },
    };

    const result = validateIVMS101Payload(invalidPayload);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/beneficiary/beneficiaryPersons/0/legalPerson/geographicAddress/0/country",
        }),
        expect.objectContaining({
          path: "/beneficiary/beneficiaryPersons/0/legalPerson/geographicAddress/0/streetName",
        }),
      ]),
    );
  });
});
