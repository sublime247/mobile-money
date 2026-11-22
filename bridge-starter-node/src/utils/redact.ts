/**
 * Deep redaction for structured log payloads.
 *
 * Pino's built-in `redact` paths only match fixed key paths, so nested or
 * arbitrarily named fields (e.g. `payload.user.newPassword`) slip through.
 * This walks the whole payload and masks any value whose key looks sensitive,
 * and any string value that looks like a payment card number.
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /pass(word|wd|phrase)|secret|token|api[-_]?key|authorization|auth(?!or)|cookie|credential|private[-_]?key|mnemonic|seed|signature|cvv|cvc|card[-_]?(number|no|num)|account[-_]?number|ssn/i;

// PIN / OTP are short enough to false-positive inside other words ("footprint",
// "shipping"), so only match them as whole words or camelCase segments.
const SENSITIVE_SHORT_KEY =
  /^(pin|otp)([-_.A-Z]|$)|[-_.](pin|otp)([-_.]|$)|[a-z](Pin|Otp|PIN|OTP)([-_.A-Z]|$)|^(PIN|OTP)/;

const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || SENSITIVE_SHORT_KEY.test(key);
}

function scrubString(value: string): string {
  return value.replace(CARD_NUMBER, (match) => {
    const digits = match.replace(/[ -]/g, "");
    return digits.length >= 13 && luhnValid(digits) ? REDACTED : match;
  });
}

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  // Errors are serialised by pino's `err` serializer; leave them intact.
  if (value instanceof Error) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(val, seen);
  }
  return out;
}
