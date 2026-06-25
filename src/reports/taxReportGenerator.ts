import { getTaxConfig } from "../services/taxService";
export async function generateTaxReport({ country, transactions, format }: TaxReportOptions): Promise<string> {
  const tax = await getTaxConfig(country);
  const reportRows = transactions.map((tx) => {
    const vat = tx.amount * tax.vatRate;
    const transferTax = tx.amount * tax.transferTaxRate;
    return {
      TransactionID: tx.id,
      UserID: tx.userId,
      Amount: tx.amount,
      VAT: vat,
      TransferTax: transferTax,
      Type: tx.type,
      Date: tx.date,
      Country: tx.country,
    };
  });
import { Parser as CsvParser } from "json2csv";
import { create } from "xmlbuilder2";

export interface Transaction {
  id: string;
  userId: string;
  amount: number;
  type: string;
  country: "CMR" | "NGA" | "GHA";
  date: string;
}

export interface TaxReportOptions {
  country: "CMR" | "NGA" | "GHA";
  transactions: Transaction[];
  format: "CSV" | "XML";
}

export function generateTaxReport({ country, transactions, format }: TaxReportOptions): string {
  const tax = taxRequirements[country];
  const reportRows = transactions.map((tx) => {
    const vat = tx.amount * tax.vatRate;
    const transferTax = tx.amount * tax.transferTaxRate;
    return {
      TransactionID: tx.id,
      UserID: tx.userId,
      Amount: tx.amount,
      VAT: vat,
      TransferTax: transferTax,
      Type: tx.type,
      Date: tx.date,
      Country: tx.country,
    };
  });

  if (format === "CSV") {
    const parser = new CsvParser();
    return parser.parse(reportRows);
  } else if (format === "XML") {
    const doc = create({
      version: "1.0",
      encoding: "UTF-8",
      standalone: true,
      taxReport: { transaction: reportRows },
    });
    return doc.end({ prettyPrint: true });
  } else {
    throw new Error("Unsupported format");
  }
}
