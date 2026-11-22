import {
  parseIdentityText,
  verifyIdentityFields,
} from "../compliance/ocrService";

describe("identity OCR verification", () => {
  it("extracts a labeled name and birth date from OCR text", () => {
    expect(
      parseIdentityText("PASSPORT\nName: José Doe\nDate of birth: 1985-04-03"),
    ).toMatchObject({
      fullName: "José Doe",
      dateOfBirth: "1985-04-03",
    });
  });

  it("requires manual review when name similarity is below 85%", () => {
    const extracted = parseIdentityText(
      "Name: Alice Johnson\nDOB: 1990-02-14",
    );

    expect(
      verifyIdentityFields(extracted, {
        fullName: "Alice Johnson",
        dateOfBirth: "1990-02-14",
      }).manualReviewRequired,
    ).toBe(false);
    expect(
      verifyIdentityFields(extracted, {
        fullName: "Completely Different",
        dateOfBirth: "1990-02-14",
      }).manualReviewRequired,
    ).toBe(true);
  });

  it("requires manual review when birth dates do not match or are missing", () => {
    const extracted = parseIdentityText("Name: Alice Johnson\nDOB: 14/02/1990");

    expect(
      verifyIdentityFields(extracted, {
        fullName: "Alice Johnson",
        dateOfBirth: "1990-02-14",
      }).dateOfBirthMatches,
    ).toBe(true);
    expect(
      verifyIdentityFields(extracted, {
        fullName: "Alice Johnson",
        dateOfBirth: "1991-02-14",
      }).manualReviewRequired,
    ).toBe(true);
    expect(
      verifyIdentityFields(
        parseIdentityText("Name: Alice Johnson"),
        { fullName: "Alice Johnson", dateOfBirth: "1990-02-14" },
      ).manualReviewRequired,
    ).toBe(true);
  });
});
