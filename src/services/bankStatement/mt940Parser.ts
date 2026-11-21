import {
  BankStatementLine,
  BankStatementParseError,
  ParsedBankStatement,
} from "./types";

interface Mt940Field {
  tag: string;
  value: string;
}

/** Extracts the {4: ... -} text block if the file carries SWIFT envelopes. */
function stripEnvelope(raw: string): string {
  const start = raw.indexOf("{4:");
  if (start === -1) return raw;
  const end = raw.indexOf("\n-}", start);
  return raw.slice(start + 3, end === -1 ? undefined : end);
}

function splitFields(text: string): Mt940Field[] {
  const normalised = text.replace(/\r\n?/g, "\n");
  const chunks = normalised.split(/\n(?=:\d{2}[A-Z]?:)/);
  const fields: Mt940Field[] = [];
  for (const chunk of chunks) {
    const m = /^\s*:(\d{2}[A-Z]?):([\s\S]*)$/.exec(chunk);
    if (m) fields.push({ tag: m[1], value: m[2].replace(/\n-\s*$/, "") });
  }
  return fields;
}

function expandYear(yy: number): number {
  return yy < 80 ? 2000 + yy : 1900 + yy;
}

function isoDate(yy: string, mm: string, dd: string): string {
  return `${expandYear(Number(yy))}-${mm}-${dd}`;
}

/** MT940 amounts use a comma as decimal separator: "1250,50" -> "1250.50". */
function normaliseAmount(raw: string): string {
  const [int, frac = ""] = raw.replace(/\s/g, "").split(",");
  return frac ? `${int}.${frac}` : int;
}

/** :60F:C240101EUR1000,00 -> currency "EUR". */
function currencyFromBalance(value: string): string | null {
  const m = /^[CD]\d{6}([A-Z]{3})/.exec(value.trim());
  return m ? m[1] : null;
}

/**
 * Flattens an :86: field. Structured (`?20..?29`, `?60..?63`) subfields are
 * joined in order; unstructured text is joined line by line.
 */
function parseInformation(value: string): string {
  const flat = value.replace(/\n/g, "");
  if (!/\?\d{2}/.test(flat)) return value.replace(/\n/g, " ").trim();

  const parts: string[] = [];
  const re = /\?(\d{2})([^?]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat))) {
    const code = Number(m[1]);
    if ((code >= 20 && code <= 29) || (code >= 60 && code <= 63)) {
      parts.push(m[2]);
    }
  }
  return parts.join(" ").trim();
}

const STATEMENT_LINE =
  /^(\d{2})(\d{2})(\d{2})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+(?:,\d*)?)N([A-Z0-9]{3})([^\n]*)(?:\n([\s\S]*))?$/;

function parseStatementLine(
  value: string,
): {
  valueDate: string;
  direction: "credit" | "debit";
  reversal: boolean;
  amount: string;
  reference: string;
  bankReference: string;
} {
  const m = STATEMENT_LINE.exec(value.trim());
  if (!m) throw new BankStatementParseError(`Invalid MT940 :61: line: ${value}`);

  const [, yy, mm, dd, , mark, , amount, , refPart] = m;
  const [customerRef, bankRef = ""] = refPart.split("//");
  const reversal = mark === "RC" || mark === "RD";
  // C / RD increase the balance; D / RC decrease it.
  const direction = mark === "C" || mark === "RD" ? "credit" : "debit";

  return {
    valueDate: isoDate(yy, mm, dd),
    direction,
    reversal,
    amount: normaliseAmount(amount),
    reference: customerRef.trim() === "NONREF" ? "" : customerRef.trim(),
    bankReference: bankRef.trim(),
  };
}

/** Parses a SWIFT MT940 customer statement (one or many statements per file). */
export function parseMt940(raw: string): ParsedBankStatement {
  const fields = splitFields(stripEnvelope(raw));
  if (!fields.some((f) => f.tag === "61")) {
    throw new BankStatementParseError("No :61: statement lines found in MT940");
  }

  const lines: BankStatementLine[] = [];
  let statementId = "";
  let accountId = "";
  let currency = "";

  for (let i = 0; i < fields.length; i++) {
    const { tag, value } = fields[i];

    if (tag === "20") {
      statementId = value.trim();
    } else if (tag === "25") {
      accountId = value.trim();
    } else if (tag === "60F" || tag === "60M") {
      currency = currencyFromBalance(value) ?? currency;
    } else if (tag === "61") {
      const parsed = parseStatementLine(value);
      const next = fields[i + 1];
      const info = next?.tag === "86" ? parseInformation(next.value) : "";

      if (!currency) {
        throw new BankStatementParseError(
          "MT940 statement has no opening balance (:60F:) to take the currency from",
        );
      }

      lines.push({
        source: "mt940",
        statementId,
        accountId,
        reference: parsed.reference,
        bankReference: parsed.bankReference,
        amount: parsed.amount,
        currency,
        direction: parsed.direction,
        reversal: parsed.reversal,
        valueDate: parsed.valueDate,
        remittanceInfo: info,
      });
    }
  }

  return { format: "mt940", lines };
}
