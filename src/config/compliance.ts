// Existing jurisdiction restrictions and FATF high-risk jurisdictions.
// https://www.fatf-gafi.org/en/countries/black-and-grey-lists.html
export const blockedPaymentCountries: ReadonlySet<string> = new Set([
  "CU",
  "IR",
  "KP",
  "SY",
  "RU",
  "BY",
  "VE",
  "MM",
  "SD",
  "SS",
]);
