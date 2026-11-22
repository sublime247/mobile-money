import { convert } from "xmlbuilder2";
import {
  BankStatementLine,
  BankStatementParseError,
  ParsedBankStatement,
} from "./types";

type Node = any;

/** Removes namespace prefixes and xmlns attributes so paths are plain names. */
function normalise(node: Node): Node {
  if (Array.isArray(node)) return node.map(normalise);
  if (node && typeof node === "object") {
    const out: Record<string, Node> = {};
    for (const [key, val] of Object.entries(node)) {
      if (key.startsWith("@xmlns")) continue;
      const name = key.includes(":") && !key.startsWith("@")
        ? key.split(":").pop()!
        : key;
      out[name] = normalise(val);
    }
    return out;
  }
  return node;
}

const arr = (v: Node): Node[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Text content of a node that may be a string, or an object with "#" text. */
function text(v: Node): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && "#" in v) return text(v["#"]);
  return "";
}

function amountOf(amt: Node): { value: string; currency: string } {
  return { value: text(amt), currency: (amt && amt["@Ccy"]) || "" };
}

function dateOf(d: Node): string {
  const raw = text(d?.Dt) || text(d?.DtTm);
  return raw.slice(0, 10);
}

function statusOf(sts: Node): string {
  return text(sts?.Cd) || text(sts);
}

function ustrd(tx: Node): string {
  return arr(tx?.RmtInf?.Ustrd).map(text).filter(Boolean).join(" ");
}

function structuredRef(tx: Node): string {
  return arr(tx?.RmtInf?.Strd)
    .map((s) => text(s?.CdtrRefInf?.Ref))
    .filter(Boolean)
    .join(" ");
}

/** Parses an ISO 20022 camt.053 bank-to-customer statement. */
export function parseCamt053(xml: string): ParsedBankStatement {
  let doc: Node;
  try {
    doc = normalise(convert(xml, { format: "object" }));
  } catch (err) {
    throw new BankStatementParseError(
      `Invalid CAMT.053 XML: ${(err as Error).message}`,
    );
  }

  const stmts = arr(doc?.Document?.BkToCstmrStmt?.Stmt);
  if (stmts.length === 0) {
    throw new BankStatementParseError("No Stmt elements found in CAMT.053");
  }

  const lines: BankStatementLine[] = [];

  for (const stmt of stmts) {
    const statementId = text(stmt.Id);
    const accountId =
      text(stmt.Acct?.Id?.IBAN) || text(stmt.Acct?.Id?.Othr?.Id);

    for (const ntry of arr(stmt.Ntry)) {
      // Only booked entries move money; skip pending/information entries.
      const sts = statusOf(ntry.Sts);
      if (sts && sts !== "BOOK") continue;

      const entryAmt = amountOf(ntry.Amt);
      const reversal = text(ntry.RvslInd).toLowerCase() === "true";
      const isCredit = text(ntry.CdtDtInd) === "CRDT";
      const direction = isCredit !== reversal ? "credit" : "debit";
      const valueDate = dateOf(ntry.ValDt) || dateOf(ntry.BookgDt);
      const entryBankRef = text(ntry.AcctSvcrRef);

      const details = arr(ntry.NtryDtls).flatMap((d) => arr(d.TxDtls));
      const txs = details.length > 0 ? details : [null];

      for (const tx of txs) {
        // Batch entries carry the per-payment amount on TxDtls.
        const txAmt = tx?.Amt ? amountOf(tx.Amt) : entryAmt;
        const refs = tx?.Refs ?? {};
        const reference =
          text(refs.EndToEndId) && text(refs.EndToEndId) !== "NOTPROVIDED"
            ? text(refs.EndToEndId)
            : text(refs.TxId) || text(refs.PmtInfId);

        const remittance = [
          tx ? ustrd(tx) : "",
          tx ? structuredRef(tx) : "",
          text(ntry.AddtlNtryInf),
        ]
          .filter(Boolean)
          .join(" ");

        lines.push({
          source: "camt053",
          statementId,
          accountId,
          reference,
          bankReference: text(refs.AcctSvcrRef) || entryBankRef,
          amount: txAmt.value,
          currency: txAmt.currency || entryAmt.currency,
          direction,
          reversal,
          valueDate,
          remittanceInfo: remittance,
        });
      }
    }
  }

  return { format: "camt053", lines };
}
