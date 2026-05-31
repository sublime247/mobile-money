export const KYC_REJECTION_REASONS = [
  "Blurry ID",
  "Expired ID",
  "Name Mismatch",
  "Address Mismatch",
  "Selfie Mismatch",
  "Unsupported Document Type",
  "Fraudulent Document",
  "Incomplete Information",
  "Other",
] as const;

export type KYCRejectionReason = (typeof KYC_REJECTION_REASONS)[number];
