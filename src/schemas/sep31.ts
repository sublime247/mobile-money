import { z } from "zod";
import { parsePhoneNumberFromString, CountryCode } from "libphonenumber-js";

const isValidE164 = (val: string) => {
  if (!val.startsWith("+")) return false;
  const parsed = parsePhoneNumberFromString(val);
  return parsed ? parsed.isValid() : false;
};

// SEP-9 Standard Fields Schema
export const sep9FieldsSchema = z.object({
  first_name: z.string().min(1, "First name is required").optional(),
  last_name: z.string().min(1, "Last name is required").optional(),
  email_address: z.string().email("Invalid email address").optional(),
  mobile_number: z.string().refine(isValidE164, {
    message: "Invalid MSISDN: must be a valid international E.164 phone number",
  }).optional(),
  bank_account_number: z.string().optional(),
  bank_number: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  country_code: z.string().length(2).optional(),
  tax_id: z.string().optional(),
  tax_id_name: z.string().optional(),
  occupation: z.number().optional(), // ISCO-08 code
  employer_name: z.string().optional(),
  employer_address: z.string().optional(),
  language_code: z.string().optional(),
  id_type: z.string().optional(),
  id_country_code: z.string().optional(),
  id_issue_date: z.string().optional(),
  id_expiration_date: z.string().optional(),
  id_number: z.string().optional(),
  photo_id_front: z.any().optional(),
  photo_id_back: z.any().optional(),
  notary_approval_of_photo_id: z.any().optional(),
  ip_address: z.string().optional(),
  photo_proof_residence: z.any().optional(),
  sex: z.enum(["male", "female", "not_applicable"]).optional(),
  proof_of_income: z.any().optional(),
  proof_of_liveness: z.any().optional(),
  referral_id: z.string().optional(),
});

// SEP-31 POST /transactions Request Body Schema
export const createSep31TransactionSchema = z.object({
  amount: z.string().min(1, "Amount is required"),
  asset_code: z.string().min(1, "Asset code is required"),
  asset_issuer: z.string().optional(),
  sender_id: z.string().optional(),
  receiver_id: z.string().optional(),
  lang: z.string().optional(),
  fields: z.object({
    transaction: z.record(z.string(), z.any()).optional(),
    sender: sep9FieldsSchema.optional(),
    receiver: sep9FieldsSchema.optional(),
  }).optional(),
}).refine(data => {
  return data.sender_id || data.fields?.transaction?.sender_id || data.fields?.sender;
}, {
  message: "Missing sender identity: provide sender_id or sender fields",
  path: ["sender_id"],
}).refine(data => {
  return data.receiver_id || data.fields?.transaction?.receiver_id || data.fields?.receiver;
}, {
  message: "Missing receiver identity: provide receiver_id or receiver fields",
  path: ["receiver_id"],
});
