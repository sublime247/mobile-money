/**
 * SEP-24 request validation.
 *
 * Wallets depositing to a shared exchange address must pass the memo the
 * exchange uses to credit the right customer. SEP-24 lets them send it as
 * `memo` + `memo_type` on the interactive deposit request; the anchor then
 * attaches it to the Stellar payment that fulfils the deposit.
 *
 * Memo formats follow the Stellar protocol limits:
 *   - text: at most 28 bytes of UTF-8
 *   - id:   unsigned 64-bit integer, as a decimal string
 *   - hash: 32 bytes, base64-encoded per SEP-24 (64-char hex also accepted)
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
 */

import { Memo } from "@stellar/stellar-sdk";
import { z } from "zod";

export const SEP24_MEMO_TYPES = ["text", "id", "hash"] as const;
export type Sep24MemoType = (typeof SEP24_MEMO_TYPES)[number];

const MAX_TEXT_MEMO_BYTES = 28;
const MAX_ID_MEMO = BigInt("18446744073709551615"); // 2^64 - 1
const HASH_MEMO_BYTES = 32;

/**
 * Decodes a hash memo to its 32 raw bytes, or returns `null` if the value is
 * not a 32-byte hash in base64 or hex.
 */
export function decodeHashMemo(value: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const bytes = Buffer.from(value, "base64");
    // Round-trip check rejects non-canonical base64 that Node would
    // otherwise decode leniently.
    if (
      bytes.length === HASH_MEMO_BYTES &&
      bytes.toString("base64") === value
    ) {
      return bytes;
    }
  }
  return null;
}

/** Returns an error message when `memo` is not valid for `memoType`. */
export function validateMemo(
  memo: string,
  memoType: Sep24MemoType,
): string | null {
  switch (memoType) {
    case "text":
      return Buffer.byteLength(memo, "utf8") <= MAX_TEXT_MEMO_BYTES
        ? null
        : `text memo must be at most ${MAX_TEXT_MEMO_BYTES} bytes`;
    case "id":
      return /^\d+$/.test(memo) && BigInt(memo) <= MAX_ID_MEMO
        ? null
        : "id memo must be an unsigned 64-bit integer";
    case "hash":
      return decodeHashMemo(memo)
        ? null
        : "hash memo must be 32 bytes, base64-encoded";
  }
}

/** Builds the Stellar SDK memo for a validated memo / memo_type pair. */
export function toStellarMemo(memo: string, memoType: Sep24MemoType): Memo {
  switch (memoType) {
    case "text":
      return Memo.text(memo);
    case "id":
      return Memo.id(memo);
    case "hash": {
      const bytes = decodeHashMemo(memo);
      if (!bytes) throw new Error("Invalid hash memo");
      return Memo.hash(bytes.toString("hex"));
    }
  }
}

/**
 * `memo` / `memo_type` pair shared by SEP-24 deposit and withdraw requests.
 *
 * `memo_type` defaults to `text` when only `memo` is sent, matching this
 * API's behaviour before memo types were supported. Sending `memo_type`
 * without `memo` is rejected, as is a memo that does not fit its type.
 */
export const sep24MemoFields = {
  memo: z.string().min(1, "memo must not be empty").optional(),
  memo_type: z.enum(SEP24_MEMO_TYPES).optional(),
};

type MemoInput = { memo?: string; memo_type?: Sep24MemoType };

function refineMemo(value: MemoInput, ctx: z.RefinementCtx): void {
  if (value.memo === undefined) {
    if (value.memo_type !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["memo"],
        message: "memo is required when memo_type is provided",
      });
    }
    return;
  }
  const error = validateMemo(value.memo, value.memo_type ?? "text");
  if (error) {
    ctx.addIssue({ code: "custom", path: ["memo"], message: error });
  }
}

function withDefaultMemoType<T extends MemoInput>(
  value: T,
): T & { memo_type?: Sep24MemoType } {
  return value.memo !== undefined && value.memo_type === undefined
    ? { ...value, memo_type: "text" }
    : value;
}

/**
 * Optional voucher code authorizing a Vodafone Cash Ghana collection
 * instead of a USSD PIN prompt (#1961). Not tied to `asset_code`/provider
 * here — the caller only sends it when routing to Vodafone Ghana — so it
 * stays a plain optional field rather than a conditionally-required one.
 */
const sep24VoucherField = {
  voucher_code: z.string().min(1, "voucher_code must not be empty").optional(),
};

/** Body of POST /transactions/deposit/interactive. */
export const sep24DepositRequestSchema = z
  .object({
    asset_code: z.string().min(1, "asset_code is required"),
    amount: z
      .union([z.string().min(1, "amount is required"), z.number()])
      .transform(String),
    account: z.string().min(1, "account is required"),
    ...sep24MemoFields,
    ...sep24VoucherField,
  })
  .passthrough()
  .superRefine(refineMemo)
  .transform(withDefaultMemoType);

export type Sep24DepositRequestInput = z.infer<
  typeof sep24DepositRequestSchema
>;

/** Formats the first zod issue as a SEP-24 style error string. */
export function formatSep24ValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request";
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}
