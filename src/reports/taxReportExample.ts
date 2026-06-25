import { generateTaxReport, TaxReportOptions, Transaction } from "./taxReportGenerator";

// Example usage: Generate a tax report for CMR in CSV format
async function runExample() {
  const transactions: Transaction[] = [
    { id: "1", userId: "U1", amount: 1000, type: "deposit", country: "CMR", date: "2026-04-24" },
    { id: "2", userId: "U2", amount: 500, type: "withdrawal", country: "CMR", date: "2026-04-24" },
  ];

  const options: TaxReportOptions = {
    country: "CMR",
    transactions,
    format: "CSV",
  };

  const csvReport = await generateTaxReport(options);
  console.log("CSV Report:\n", csvReport);

  const xmlOptions: TaxReportOptions = {
    ...options,
    format: "XML",
  };

  const xmlReport = await generateTaxReport(xmlOptions);
  console.log("XML Report:\n", xmlReport);
}

runExample();
