import cron from "node-cron";

export interface ReportPeriod {
  from: Date;
  to: Date;
}

export interface TransactionSummary {
  transactionCount: number;
  transactionVolume: string;
  feeRevenue: string;
  failedTransactions: number;
  failureRate: number;
}

export interface CountrySummary {
  country: string;
  transactionCount: number;
  transactionVolume: string;
  feeRevenue: string;
  failedTransactions: number;
  failureRate: number;
}

export interface ProviderSummary {
  provider: string;
  transactionCount: number;
  transactionVolume: string;
  feeRevenue: string;
  failedTransactions: number;
  failureRate: number;
}

export interface MonthlyReport {
  reportPeriod: ReportPeriod;
  generatedAt: Date;

  summary: TransactionSummary;

  byCountry: CountrySummary[];

  byProvider: ProviderSummary[];
}
export function getPreviousMonthPeriod(
  date = new Date()
): ReportPeriod {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  const from = new Date(
    Date.UTC(year, month - 1, 1)
  );

  const to = new Date(
    Date.UTC(year, month, 1)
  );

  return {
    from,
    to,
  };
}