// src/services/travelRule.ts

export interface NaturalPerson {
  name: {
    nameIdentifier: Array<{
      primaryIdentifier: string;
      secondaryIdentifier?: string;
      nameIdentifierType: "LEGL" | "ALIA" | "BIRT" | "MAID";
    }>;
  };

  geographicAddress?: {
    addressType?: "HOME" | "GEOG" | "BIZZ";
    streetName?: string;
    buildingNumber?: string;
    buildingName?: string;
    postcode?: string;
    townName?: string;
    countrySubDivision?: string;
    country: string;
  };

  nationalIdentification?: {
    nationalIdentifier: string;
    nationalIdentifierType:
      | "CCPT"
      | "DRLC"
      | "IDCD"
      | "TXID"
      | "SOCS";
    countryOfIssue?: string;
  };

  customerIdentification?: {
    customerIdentification: string;
    customerIdentificationType: string;
    countryOfIssue?: string;
  };

  dateAndPlaceOfBirth?: {
    dateOfBirth: string;
    placeOfBirth?: string;
    countryOfBirth?: string;
  };
}