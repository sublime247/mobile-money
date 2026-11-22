import { parseCamt053 } from "./camt053Parser";
import { parseMt940 } from "./mt940Parser";
import {
  BankStatementFormat,
  BankStatementParseError,
  ParsedBankStatement,
} from "./types";

export * from "./types";
export { parseMt940 } from "./mt940Parser";
export { parseCamt053 } from "./camt053Parser";

/** Detects whether a statement file is CAMT.053 XML or SWIFT MT940. */
export function detectStatementFormat(content: string): BankStatementFormat {
  const head = content.trimStart();
  if (head.startsWith("<") && /<(\w+:)?Document[\s>]/.test(content)) {
    return "camt053";
  }
  if (/:20:/.test(content) && /:61:/.test(content)) return "mt940";
  throw new BankStatementParseError(
    "Unrecognised bank statement format (expected MT940 or CAMT.053)",
  );
}

export function parseBankStatement(content: string): ParsedBankStatement {
  return detectStatementFormat(content) === "camt053"
    ? parseCamt053(content)
    : parseMt940(content);
}
