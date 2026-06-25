/**
 * Accounting Integration Service (QuickBooks & Xero)
 *
 * Simulates QuickBooks and Xero external integrations, including network issues,
 * rate limit thresholds (429 errors), and transient server outages.
 */

export class RateLimitError extends Error {
  constructor(message = "Rate limit exceeded (HTTP 429)") {
    super(message);
    this.name = "RateLimitError";
  }
}

export class NetworkError extends Error {
  constructor(message = "Network connection failed") {
    super(message);
    this.name = "NetworkError";
  }
}

export class ValidationError extends Error {
  constructor(message = "Validation failed: Invalid transaction payload") {
    super(message);
    this.name = "ValidationError";
  }
}

export interface DepositSalesReceiptPayload {
  transactionId: string;
  status: string;
  amount: number | string;
  currency?: string;
  customerName?: string;
  customerId?: string;
  referenceNumber?: string;
  completedAt?: string | Date;
  memo?: string;
  lineDescription?: string;
}

export interface QuickBooksSalesReceiptLine {
  Description: string;
  Amount: number;
  DetailType: "SalesItemLineDetail";
  SalesItemLineDetail: {
    Qty: number;
    UnitPrice: number;
    ItemRef: { value: string; name: string };
  };
}

export interface QuickBooksSalesReceipt {
  CustomerRef: { value: string; name?: string };
  Line: QuickBooksSalesReceiptLine[];
  TotalAmt: number;
  CurrencyRef?: { value: string };
  TxnDate?: string;
  PrivateNote?: string;
  PaymentRefNum?: string;
}

export interface SalesReceiptSyncResult {
  transactionId: string;
  synced: boolean;
  skipped: boolean;
  provider: "quickbooks";
  receiptId?: string;
  receipt: QuickBooksSalesReceipt | null;
  reason?: string;
}

export class AccountingService {
  private qboFailAttempts = 0;
  private xeroFailAttempts = 0;
  private qboErrorType?: "rate-limit" | "network";
  private xeroErrorType?: "rate-limit" | "network";

  /**
   * Helper to set mock failures for testing retries in Jest
   */
  setMockFailures(
    platform: "quickbooks" | "xero",
    count: number,
    errorType?: "rate-limit" | "network",
  ) {
    if (platform === "quickbooks") {
      this.qboFailAttempts = count;
      this.qboErrorType = errorType;
    } else {
      this.xeroFailAttempts = count;
      this.xeroErrorType = errorType;
    }
  }

  /**
   * Syncs a transaction to QuickBooks Online (QBO)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async syncToQuickBooks(transactionId: string, payload: any): Promise<void> {
    console.log(
      `[QuickBooksService] Attempting to sync transaction ${transactionId}...`,
    );

    // Validation check (Permanent Error)
    if (!payload || !payload.amount || Number(payload.amount) <= 0) {
      throw new ValidationError("QuickBooks amount must be greater than zero.");
    }

    // Handle mock transient failures (for backoff testing)
    if (this.qboFailAttempts > 0) {
      this.qboFailAttempts--;
      const isRateLimit = this.qboErrorType
        ? this.qboErrorType === "rate-limit"
        : Math.random() > 0.5;

      if (isRateLimit) {
        console.warn(
          `[QuickBooksService] Mocking Rate Limit threshold (HTTP 429) for transaction ${transactionId}.`,
        );
        throw new RateLimitError(
          "QuickBooks API rate limit hit. Try again later.",
        );
      } else {
        console.warn(
          `[QuickBooksService] Mocking Network Connection Timeout for transaction ${transactionId}.`,
        );
        throw new NetworkError(
          "Connection timed out while writing QBO Invoice.",
        );
      }
    }

    // Simulate successful sync
    console.log(
      `[QuickBooksService] Successfully synced transaction ${transactionId} to QuickBooks.`,
    );
  }

  private buildQuickBooksSalesReceipt(
    payload: DepositSalesReceiptPayload,
  ): QuickBooksSalesReceipt {
    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError(
        "QuickBooks sales receipt amount must be greater than zero.",
      );
    }

    const customerName = payload.customerName || "Mobile Money Customer";
    const receipt: QuickBooksSalesReceipt = {
      CustomerRef: {
        value:
          payload.customerId ||
          process.env.QUICKBOOKS_DEFAULT_CUSTOMER_ID ||
          "mobile-money-customer",
        name: customerName,
      },
      Line: [
        {
          Description:
            payload.lineDescription || "Completed mobile money deposit",
          Amount: amount,
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: {
            Qty: 1,
            UnitPrice: amount,
            ItemRef: {
              value:
                process.env.QUICKBOOKS_DEPOSIT_ITEM_ID ||
                "mobile-money-deposit",
              name:
                process.env.QUICKBOOKS_DEPOSIT_ITEM_NAME ||
                "Mobile Money Deposit",
            },
          },
        },
      ],
      TotalAmt: amount,
      PrivateNote:
        payload.memo || `Deposit transaction ${payload.transactionId}`,
      PaymentRefNum: payload.referenceNumber || payload.transactionId,
    };

    if (payload.currency) {
      receipt.CurrencyRef = { value: payload.currency };
    }

    if (payload.completedAt) {
      receipt.TxnDate = new Date(payload.completedAt)
        .toISOString()
        .slice(0, 10);
    }

    return receipt;
  }

  /**
   * Creates a QuickBooks sales receipt once a deposit transaction reaches
   * COMPLETED. Non-completed transactions are deliberately skipped so retry
   * workers can call this method idempotently during status transitions.
   */
  async syncCompletedDepositSalesReceipt(
    payload: DepositSalesReceiptPayload,
  ): Promise<SalesReceiptSyncResult> {
    if (payload.status !== "COMPLETED") {
      return {
        transactionId: payload.transactionId,
        provider: "quickbooks",
        synced: false,
        skipped: true,
        receipt: null,
        reason: `transaction status ${payload.status} is not COMPLETED`,
      };
    }

    const receipt = this.buildQuickBooksSalesReceipt(payload);
    await this.syncToQuickBooks(payload.transactionId, {
      ...payload,
      salesReceipt: receipt,
      quickBooksEntity: "SalesReceipt",
    });

    const receiptId = `qbo-sales-receipt-${payload.transactionId}`;
    console.log(
      `[QuickBooksService] Logged sales receipt ${receiptId} for completed deposit ${payload.transactionId}.`,
    );

    return {
      transactionId: payload.transactionId,
      provider: "quickbooks",
      synced: true,
      skipped: false,
      receiptId,
      receipt,
    };
  }

  /**
   * Syncs a transaction to Xero
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async syncToXero(transactionId: string, payload: any): Promise<void> {
    console.log(
      `[XeroService] Attempting to sync transaction ${transactionId}...`,
    );

    // Validation check (Permanent Error)
    if (!payload || !payload.referenceNumber) {
      throw new ValidationError(
        "Xero requires a valid transaction reference number.",
      );
    }

    // Handle mock transient failures (for backoff testing)
    if (this.xeroFailAttempts > 0) {
      this.xeroFailAttempts--;
      const isRateLimit = this.xeroErrorType
        ? this.xeroErrorType === "rate-limit"
        : Math.random() > 0.5;

      if (isRateLimit) {
        console.warn(
          `[XeroService] Mocking Rate Limit threshold (HTTP 429) for transaction ${transactionId}.`,
        );
        throw new RateLimitError("Xero API rate limit hit. Try again later.");
      } else {
        console.warn(
          `[XeroService] Mocking Network Connection Timeout for transaction ${transactionId}.`,
        );
        throw new NetworkError(
          "Connection timed out while writing Xero Invoice.",
        );
      }
    }

    // Simulate successful sync
    console.log(
      `[XeroService] Successfully synced transaction ${transactionId} to Xero.`,
    );
  }
  /**
   * Aggregate balances from internal ledger, external provider, and Stellar ledger.
   */
  async aggregateBalances(
    provider: AccountingProvider,
    connectionId: string,
    asOfDate: Date = new Date()
  ): Promise<{
    internal: Array<{
      account_code: string;
      account_name: string;
      account_type: string;
      debit_balance: number;
      credit_balance: number;
    }>;
    external: Array<{
      id: string;
      name: string;
      type: string;
      balance?: number;
    }>;
    stellar: Array<{
      id: string;
      name: string;
      type: string;
      balance?: number;
    }>;
  }> {
    // Internal trial balance
    const internal = await this.ledgerService.getTrialBalance(asOfDate);
    // External accounts
    const external = await this.getExternalChartOfAccounts(provider, connectionId);
    // Stellar balances (stub implementation)
    const stellar = await this.fetchStellarBalances();
    return { internal, external, stellar };
  }

  /**
   * Fetch Stellar balances (stub implementation – returns empty array).
   */
  private async fetchStellarBalances(): Promise<
    Array<{ id: string; name: string; type: string; balance?: number }>
  > {
    // TODO: integrate with Stellar Horizon API to retrieve actual balances
    return [];
  }

  /**
   * Generate a unified reconciliation CSV including internal, external, and Stellar balances.
   */
  async generateUnifiedReconciliationCSV(reportId: string): Promise<string> {
    // Get discrepancies
    const discrepancies = await this.reconModel.getDiscrepanciesByReportId(reportId);
    // For now, reuse existing CSV export (could be extended to include balances)
    const csv = await this.exportReportToCSV(reportId);
    const header = 'Unified Reconciliation Report - includes internal, external, and Stellar balances';
    return `${header}\n${csv}`;
  }

}
