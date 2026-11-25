import { z } from "zod";

/**
 * Supported EcoCash currencies in Zimbabwe's multi-currency economy.
 * EcoCash supports USD and Zimbabwe Gold (ZIG / ZiG).
 */
export const SUPPORTED_ECOCASH_CURRENCIES = ["USD", "ZIG"] as const;
export type EcoCashCurrency = (typeof SUPPORTED_ECOCASH_CURRENCIES)[number];

/**
 * Normalizes input currency string to canonical EcoCashCurrency ("USD" or "ZIG").
 * Accepts "USD", "usd", "ZIG", "zig", "ZiG".
 * Throws a ZodError or standard Error for unsupported currencies.
 */
export function normalizeEcoCashCurrency(currency: string): EcoCashCurrency {
  if (typeof currency !== "string") {
    throw new Error("Currency must be a string");
  }
  const normalized = currency.trim().toUpperCase();
  if (normalized === "USD") return "USD";
  if (normalized === "ZIG" || normalized === "ZWL") return "ZIG";
  throw new Error(
    `Unsupported currency "${currency}": EcoCash only supports USD and ZIG (Zimbabwe Gold)`,
  );
}

/**
 * Zod schema for EcoCash currency code validation.
 */
export const ecocashCurrencySchema = z
  .string()
  .transform((val) => val.trim().toUpperCase())
  .refine(
    (val): val is "USD" | "ZIG" => val === "USD" || val === "ZIG",
    {
      message:
        "Unsupported currency: EcoCash only supports USD and ZIG (Zimbabwe Gold)",
    },
  );

/**
 * Zimbabwe MSISDN subscriber number validator:
 * Zimbabwe country code is +263, followed by a 9-digit subscriber number.
 */
export const ecocashPhoneNumberSchema = z
  .string()
  .refine(
    (val) => {
      const digits = val.replace(/\D/g, "");
      return /^263\d{9}$/.test(digits) || /^\+263\d{9}$/.test(val.trim());
    },
    {
      message:
        "EcoCash only supports Zimbabwe (+263) subscriber numbers",
    },
  );

/**
 * Amount validator: must be a positive finite number.
 */
export const ecocashAmountSchema = z
  .union([z.number(), z.string()])
  .transform((val) => Number(val))
  .refine((num) => Number.isFinite(num) && num > 0, {
    message: "Amount must be a positive number",
  });

/**
 * Schema for EcoCash deposit (payment initiation / collection) requests.
 */
export const ecocashPaymentSchema = z.object({
  phoneNumber: ecocashPhoneNumberSchema,
  amount: ecocashAmountSchema,
  currency: ecocashCurrencySchema,
  reference: z.string().optional(),
  exchangeRate: z.number().positive().optional(),
});

/**
 * Schema for EcoCash disbursement (payout) requests.
 */
export const ecocashDisbursementSchema = z.object({
  phoneNumber: ecocashPhoneNumberSchema,
  amount: ecocashAmountSchema,
  currency: ecocashCurrencySchema,
  reference: z.string().optional(),
  exchangeRate: z.number().positive().optional(),
});

export type EcoCashPaymentInput = z.infer<typeof ecocashPaymentSchema>;
export type EcoCashDisbursementInput = z.infer<typeof ecocashDisbursementSchema>;

export function validateEcoCashPayment(data: unknown): EcoCashPaymentInput {
  return ecocashPaymentSchema.parse(data);
}

export function validateEcoCashDisbursement(
  data: unknown,
): EcoCashDisbursementInput {
  return ecocashDisbursementSchema.parse(data);
}
